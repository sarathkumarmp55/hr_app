# Copyright (c) 2026, Future HR and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import format_time, get_datetime, getdate, today


def _format_time_safe(dt_val):
	if not dt_val:
		return None
	try:
		return format_time(dt_val, "hh:mm a")
	except Exception:
		try:
			return str(dt_val)[11:16]
		except Exception:
			return None


def get_current_user_employee(user=None):
	"""Get Employee document name associated with the user account."""
	if not user:
		user = frappe.session.user

	# 1. Direct user_id link
	emp = frappe.db.get_value("Employee", {"user_id": user, "status": "Active"}, "name")
	if not emp:
		emp = frappe.db.get_value("Employee", {"user_id": user}, "name")

	# 2. Match by email if user_id was not explicitly set
	if not emp:
		emp = frappe.db.get_value("Employee", {"company_email": user, "status": "Active"}, "name")
	if not emp:
		emp = frappe.db.get_value("Employee", {"personal_email": user, "status": "Active"}, "name")
	if not emp:
		emp = frappe.db.get_value("Employee", {"prefered_email": user, "status": "Active"}, "name")

	return emp


@frappe.whitelist()
def get_attendance_data(date=None):
	"""Fetch attendance data.
	- Role 'HR Manager' (or System Manager / Administrator): Full organization dashboard with all active employees.
	- Other roles (Employee, HR User, etc.): Restricted to their OWN attendance data only.
	"""
	if not date:
		date = today()
	else:
		date = str(getdate(date))

	start_dt = f"{date} 00:00:00"
	end_dt = f"{date} 23:59:59"

	user = frappe.session.user
	user_roles = frappe.get_roles(user)

	# Check if user has HR Manager access (or System Manager / Administrator)
	is_hr_manager = bool(
		"HR Manager" in user_roles or "System Manager" in user_roles or user == "Administrator"
	)

	extra_conditions = ""
	params = {"start": start_dt, "end": end_dt}
	current_employee_id = None

	if not is_hr_manager:
		current_employee_id = get_current_user_employee(user)
		if not current_employee_id:
			# Regular user without an active Employee record linked
			return {
				"date": date,
				"is_hr_manager": False,
				"current_employee": None,
				"user": user,
				"no_employee_linked": True,
				"summary": {"total": 0, "checked_in": 0, "checked_out": 0, "not_in": 0},
				"employees": [],
				"message": f"No active Employee profile linked to your user account ({user}). Please contact your HR Manager.",
			}

		extra_conditions = " AND e.name = %(emp_id)s "
		params["emp_id"] = current_employee_id

	# Single optimized query to fetch active employees and their checkins
	records = frappe.db.sql(
		f"""
		SELECT
			e.name AS employee_id,
			e.employee_name,
			e.designation,
			e.department,
			e.image,
			MIN(CASE WHEN ec.log_type = 'IN' THEN ec.time END) AS tagged_in_time,
			MAX(CASE WHEN ec.log_type = 'OUT' THEN ec.time END) AS tagged_out_time,
			MIN(ec.time) AS min_time,
			MAX(ec.time) AS max_time,
			COUNT(ec.name) AS punch_count
		FROM `tabEmployee` e
		LEFT JOIN `tabEmployee Checkin` ec
			ON ec.employee = e.name
			AND ec.time >= %(start)s
			AND ec.time <= %(end)s
		WHERE e.status = 'Active' {extra_conditions}
		GROUP BY e.name, e.employee_name, e.designation, e.department, e.image
		ORDER BY e.employee_name ASC
		""",
		params,
		as_dict=True,
	)

	# Minimum gap required after check-in for a punch to be considered an OUT punch (default 1 hour = 3600s)
	# Any punch occurring within 1 hour after check-in is treated as duplicate/accidental and skipped.
	min_gap_seconds = 3600
	try:
		gap_val = frappe.db.get_single_value("Biometrics Settings", "min_punch_gap_mins")
		if gap_val:
			min_gap_seconds = int(gap_val) * 60
	except Exception:
		min_gap_seconds = 3600

	employees = []
	for r in records:
		punch_count = int(r.get("punch_count") or 0)
		tagged_in = r.get("tagged_in_time")
		tagged_out = r.get("tagged_out_time")
		min_time = r.get("min_time")
		max_time = r.get("max_time")

		# First IN: earliest punch of the day
		first_in_dt = min_time or tagged_in if punch_count > 0 else None

		# Last OUT: candidate OUT punches within min_gap_seconds (1 hour) of check-in
		# are duplicate/accidental and must be skipped. An OUT punch is only recognized
		# if it occurs >= 1 hour after first IN.
		last_out_dt = None
		if first_in_dt and punch_count > 1 and min_time != max_time:
			in_dt_obj = get_datetime(first_in_dt)
			max_dt_obj = get_datetime(max_time)

			if (max_dt_obj - in_dt_obj).total_seconds() >= min_gap_seconds:
				if tagged_out and (get_datetime(tagged_out) - in_dt_obj).total_seconds() >= min_gap_seconds:
					last_out_dt = tagged_out
				else:
					last_out_dt = max_time

		has_in = bool(first_in_dt)
		has_out = bool(last_out_dt)

		if not has_in:
			status = "NOT_IN"  # Not arrived / Absent
		elif has_in and not has_out:
			status = "CHECKED_IN"  # In office (IN arrow blinks)
		else:
			status = "CHECKED_OUT"  # Left office (OUT arrow blinks)

		employees.append(
			{
				"employee_id": r.get("employee_id"),
				"employee_name": r.get("employee_name") or r.get("employee_id"),
				"designation": r.get("designation") or "Not Specified",
				"department": r.get("department") or "",
				"image": r.get("image") or "",
				"has_in": has_in,
				"has_out": has_out,
				"in_time": _format_time_safe(first_in_dt),
				"out_time": _format_time_safe(last_out_dt),
				"in_time_raw": str(first_in_dt) if first_in_dt else None,
				"out_time_raw": str(last_out_dt) if last_out_dt else None,
				"status": status,
				"punch_count": punch_count,
			}
		)

	summary = {
		"total": len(employees),
		"checked_in": sum(1 for e in employees if e["status"] == "CHECKED_IN"),
		"checked_out": sum(1 for e in employees if e["status"] == "CHECKED_OUT"),
		"not_in": sum(1 for e in employees if e["status"] == "NOT_IN"),
	}

	return {
		"date": date,
		"is_hr_manager": is_hr_manager,
		"current_employee": current_employee_id,
		"user": user,
		"no_employee_linked": False,
		"summary": summary,
		"employees": employees,
	}
