# Copyright (c) 2026, Future HR and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import format_time, getdate, nowdate, today


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


@frappe.whitelist()
def get_attendance_data(date=None):
	"""Fetch all active employees with their today's attendance status (first IN, last OUT).
	Optimized single query with LEFT JOIN.
	"""
	if not date:
		date = today()
	else:
		date = str(getdate(date))

	start_dt = f"{date} 00:00:00"
	end_dt = f"{date} 23:59:59"

	# Single optimized query to fetch active employees and their checkins
	records = frappe.db.sql(
		"""
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
		WHERE e.status = 'Active'
		GROUP BY e.name, e.employee_name, e.designation, e.department, e.image
		ORDER BY e.employee_name ASC
		""",
		{"start": start_dt, "end": end_dt},
		as_dict=True,
	)

	employees = []
	for r in records:
		punch_count = int(r.get("punch_count") or 0)
		tagged_in = r.get("tagged_in_time")
		tagged_out = r.get("tagged_out_time")
		min_time = r.get("min_time")
		max_time = r.get("max_time")

		# First IN: prefer tagged_in, fallback to min_time if any punch exists
		first_in_dt = tagged_in or (min_time if punch_count > 0 else None)

		# Last OUT: prefer tagged_out, fallback to max_time if multiple punches and max != min
		last_out_dt = tagged_out
		if not last_out_dt and punch_count > 1 and min_time != max_time:
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
		"summary": summary,
		"employees": employees,
	}
