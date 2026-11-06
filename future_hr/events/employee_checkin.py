# Copyright (c) 2026, Future HR and contributors
# For license information, please see license.txt

import time
from datetime import timedelta
import frappe
from frappe.utils import get_datetime, now_datetime, getdate, nowdate


def _get_settings():
    """Fetch and validate Biometrics Settings singleton."""
    settings = frappe.get_single("Biometrics Settings")
    if not settings.enabled:
        return None
    if not settings.server or not settings.db_user or not settings.get_password("db_password"):
        frappe.log_error(
            title="Biometrics Sync - Missing Configuration",
            message="Biometrics sync is enabled but server/user/password is not configured. "
                    "Please complete the Biometrics Settings.",
        )
        return None
    return settings


def _get_mssql_connection(settings):
    """Open and return an MSSQL connection using settings."""
    import pymssql

    return pymssql.connect(
        server=settings.server,
        port=int(settings.port or 1433),
        user=settings.db_user,
        password=settings.get_password("db_password"),
        login_timeout=int(settings.login_timeout or 30),
        timeout=int(settings.query_timeout or 60),
    )


def _get_employee_maps():
    """Pre-fetch employee lookup maps in 1 query:
    Priority 1: Employee ID in ERP (name / employee_number)
    Priority 2: RFID / Attendance Device ID (attendance_device_id)
    """
    emp_records = frappe.get_all(
        "Employee",
        fields=["name", "employee_number", "attendance_device_id"],
    )
    emp_id_map = {}
    rfid_map = {}

    for emp in emp_records:
        if emp.name:
            emp_id_map[str(emp.name).strip()] = emp.name
        if emp.get("employee_number"):
            emp_id_map[str(emp.employee_number).strip()] = emp.name
        if emp.get("attendance_device_id"):
            rfid_map[str(emp.attendance_device_id).strip()] = emp.name

    return emp_id_map, rfid_map


def _update_sync_status(status, message, latest_log_datetime=None):
    """Update last sync info on Biometrics Settings."""
    try:
        update_dict = {
            "last_sync_time": now_datetime(),
            "last_sync_status": status,
            "last_sync_message": str(message)[:500],
        }
        if latest_log_datetime:
            update_dict["last_synced_log_datetime"] = latest_log_datetime
        frappe.db.set_single_value("Biometrics Settings", update_dict)
        frappe.db.commit()
    except Exception:
        pass


def _create_sync_log(sync_type="Scheduled", **kwargs):
    """Create a Biometrics Sync Log entry."""
    try:
        frappe.get_doc({
            "doctype": "Biometrics Sync Log",
            "sync_time": now_datetime(),
            "sync_type": sync_type,
            "status": kwargs.get("status", "Success"),
            "total_logs_fetched": kwargs.get("total_logs_fetched", 0),
            "imported": kwargs.get("imported", 0),
            "skipped": kwargs.get("skipped", 0),
            "unmapped_count": kwargs.get("unmapped_count", 0),
            "unmapped_device_ids": kwargs.get("unmapped_device_ids", ""),
            "message": str(kwargs.get("message", ""))[:500],
            "error_traceback": kwargs.get("error_traceback", ""),
            "duration_seconds": kwargs.get("duration_seconds", 0),
        }).insert(ignore_permissions=True)
        frappe.db.commit()
    except Exception:
        frappe.log_error(
            title="Biometrics Sync Log - Failed to Create",
            message=frappe.get_traceback(),
        )


def update_in_out_for_employee_date(employee, date_str, min_gap_mins=60):
    """Assign log_type = 'IN' to the first punch of the day,
    and log_type = 'OUT' to the last valid punch of the day (at least min_gap_mins after IN).
    All other punches on that day have log_type set to None for audit tracking.
    """
    if not employee or not date_str:
        return

    start_dt = f"{date_str} 00:00:00"
    end_dt = f"{date_str} 23:59:59"

    checkins = frappe.get_all(
        "Employee Checkin",
        filters={
            "employee": employee,
            "time": ["between", [start_dt, end_dt]],
        },
        fields=["name", "time", "log_type"],
        order_by="time ASC",
    )

    if not checkins:
        return

    # First punch of the day is Punch In
    first_punch = checkins[0]
    in_time = get_datetime(first_punch.time)
    min_gap = timedelta(minutes=int(min_gap_mins or 60))

    # Valid out candidates must have at least min_gap (60 mins) after in_time
    valid_out_candidates = [
        c for c in checkins
        if get_datetime(c.time) >= (in_time + min_gap)
    ]

    in_name = first_punch.name
    out_name = valid_out_candidates[-1].name if valid_out_candidates else None

    for c in checkins:
        target_log_type = None
        if c.name == in_name:
            target_log_type = "IN"
        elif c.name == out_name:
            target_log_type = "OUT"

        if c.log_type != target_log_type:
            frappe.db.set_value(
                "Employee Checkin",
                c.name,
                "log_type",
                target_log_type,
                update_modified=False,
            )


@frappe.whitelist()
def get_attendance_logs(limit=100):
    """Return recent raw attendance logs from biometrics server (preview/diagnostics)."""
    settings = _get_settings()
    if not settings:
        frappe.throw("Biometrics sync is disabled or not configured. Check Biometrics Settings.")

    conn = None
    try:
        conn = _get_mssql_connection(settings)
        cursor = conn.cursor(as_dict=True)

        table = settings.database_table or "dbo.EssLData"
        emp_col = settings.employee_code_field or "EmployeeCode"
        dt_col = settings.log_datetime_field or "LogDateTime"
        dev_col = settings.device_name_field or "DeviceName"

        limit = min(int(limit or 100), 500)
        cursor.execute(
            f"SELECT TOP {limit} [{emp_col}], [{dt_col}], [{dev_col}] "
            f"FROM {table} ORDER BY [{dt_col}] DESC"
        )
        return cursor.fetchall()

    except Exception as e:
        frappe.log_error(title="Biometrics - Get Attendance Logs Failed", message=frappe.get_traceback())
        frappe.throw(f"Failed to fetch attendance logs: {str(e)}")
    finally:
        if conn:
            conn.close()


def sync_attendance_logs(sync_type="Scheduled"):
    """Sync attendance logs from biometrics MSSQL to Employee Checkin.

    Strategy:
    - Uses stored watermark `last_synced_log_datetime` in Biometrics Settings.
    - Falls back to MAX(time) in Employee Checkin on first-ever sync.
    - Check Employee ID in ERP first, then fallback to RFID.
    - Automatically marks first valid punch of day as 'IN' and last valid punch as 'OUT'.
    """
    settings = _get_settings()
    if not settings:
        return

    conn = None
    start_time = time.time()

    try:
        table = settings.database_table or "dbo.EssLData"
        emp_col = settings.employee_code_field or "EmployeeCode"
        dt_col = settings.log_datetime_field or "LogDateTime"
        dev_col = settings.device_name_field or "DeviceName"

        if sync_type == "Manual":
            frappe.publish_progress(15, title="Syncing Biometrics Logs", description="Connecting to biometrics server...")

        watermark = settings.last_synced_log_datetime

        if not watermark:
            row = frappe.db.sql("SELECT MAX(time) FROM `tabEmployee Checkin`")[0][0]
            watermark = get_datetime(row) if row else None

        conn = _get_mssql_connection(settings)
        cursor = conn.cursor(as_dict=True)

        if watermark:
            cursor.execute(
                f"SELECT DISTINCT [{emp_col}] AS EmployeeCode, [{dt_col}] AS LogDateTime, "
                f"[{dev_col}] AS DeviceName FROM {table} "
                f"WHERE [{dt_col}] > %s ORDER BY [{dt_col}] ASC",
                (watermark,)
            )
        else:
            cursor.execute(
                f"SELECT DISTINCT [{emp_col}] AS EmployeeCode, [{dt_col}] AS LogDateTime, "
                f"[{dev_col}] AS DeviceName FROM {table} ORDER BY [{dt_col}] ASC"
            )

        logs = cursor.fetchall()
        cursor.close()

        total_fetched = len(logs)

        if not logs:
            duration = round(time.time() - start_time, 2)
            msg = "No new biometric logs since last sync."
            _update_sync_status("Success", msg)
            _create_sync_log(sync_type=sync_type, status="Success", message=msg, duration_seconds=duration)
            if sync_type == "Manual":
                frappe.publish_progress(100, title="Syncing Biometrics Logs", description=msg)
            return

        if sync_type == "Manual":
            frappe.publish_progress(35, title="Syncing Biometrics Logs", description=f"Fetched {total_fetched} new logs. Importing...")

        emp_id_map, rfid_map = _get_employee_maps()

        imported = 0
        unmapped_codes = set()
        latest_log_dt = None
        affected_pairs = set()
        progress_step = max(1, total_fetched // 15)

        for idx, log in enumerate(logs, 1):
            raw_code = log.get("EmployeeCode")
            raw_time = log.get("LogDateTime")
            device_name = (log.get("DeviceName") or "").strip()

            if not raw_code or not raw_time:
                continue

            emp_code = str(raw_code).strip()
            log_time = get_datetime(raw_time)

            if not latest_log_dt or log_time > latest_log_dt:
                latest_log_dt = log_time

            # Priority 1: Check Employee ID in ERP, Priority 2: RFID
            employee = emp_id_map.get(emp_code) or rfid_map.get(emp_code)
            if not employee:
                unmapped_codes.add(emp_code)
                continue

            checkin = frappe.new_doc("Employee Checkin")
            checkin.employee = employee
            checkin.time = log_time
            checkin.device_id = device_name
            checkin.flags.ignore_in_out_hook = True
            checkin.insert(ignore_permissions=True)
            imported += 1
            affected_pairs.add((employee, str(getdate(log_time))))

            if sync_type == "Manual" and (idx % progress_step == 0 or idx == total_fetched):
                pct = 35 + int((idx / total_fetched) * 55)
                frappe.publish_progress(
                    percent=pct,
                    title="Syncing Biometrics Logs",
                    description=f"Importing log {idx} of {total_fetched}...",
                )

        if imported > 0:
            frappe.db.commit()

        # Update IN / OUT log_type for affected employee-dates
        min_gap = int(getattr(settings, "min_punch_gap_mins", 60) or 60)
        for emp, date_str in affected_pairs:
            update_in_out_for_employee_date(emp, date_str, min_gap)

        frappe.db.commit()

        duration = round(time.time() - start_time, 2)

        unmapped_list_str = ""
        if unmapped_codes:
            sorted_codes = sorted(unmapped_codes)
            unmapped_list_str = ", ".join(sorted_codes[:50])
            if len(sorted_codes) > 50:
                unmapped_list_str += f" (+{len(sorted_codes) - 50} more)"

        msg_parts = [f"Imported: {imported}", f"Fetched: {total_fetched}"]
        if unmapped_codes:
            msg_parts.append(f"Unmapped: {len(unmapped_codes)}")
        status_msg = " | ".join(msg_parts)

        _update_sync_status("Success", status_msg, latest_log_datetime=latest_log_dt)
        _create_sync_log(
            sync_type=sync_type,
            status="Success",
            total_logs_fetched=total_fetched,
            imported=imported,
            skipped=len(unmapped_codes),
            unmapped_count=len(unmapped_codes),
            unmapped_device_ids=unmapped_list_str,
            message=status_msg,
            duration_seconds=duration,
        )

        if sync_type == "Manual":
            frappe.publish_progress(100, title="Syncing Biometrics Logs", description=f"Completed! {status_msg}")

        frappe.logger("biometrics_sync").info(f"Biometrics sync done in {duration}s. {status_msg}")

    except ImportError:
        duration = round(time.time() - start_time, 2)
        error_msg = "pymssql is not installed. Run: pip install pymssql"
        _update_sync_status("Failed", error_msg)
        _create_sync_log(sync_type=sync_type, status="Failed", message=error_msg,
                         error_traceback=error_msg, duration_seconds=duration)
        frappe.log_error(title="Biometrics Sync - Missing Dependency", message=error_msg)

    except Exception:
        duration = round(time.time() - start_time, 2)
        tb = frappe.get_traceback()
        _update_sync_status("Failed", tb[:500])
        frappe.db.rollback()
        _create_sync_log(sync_type=sync_type, status="Failed", message=str(tb)[:500],
                         error_traceback=tb, duration_seconds=duration)
        frappe.log_error(title="Biometrics Sync Failed", message=tb)

    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


@frappe.whitelist()
def pull_manual_attendance_logs(from_datetime, to_datetime, employee=None):
    """Manually pull attendance logs from MSSQL with custom date/time range and optional employee.

    Validations:
    - from_datetime and to_datetime are required.
    - to_datetime >= from_datetime.
    - Maximum 31 days range allowed in a single fetch.
    - Avoids duplicates: only inserts records not already existing in Employee Checkin.
    - Updates first punch of day as 'IN' and last valid punch as 'OUT'.
    - Displays real-time status bar updates via frappe.publish_progress.
    """
    if not from_datetime or not to_datetime:
        frappe.throw("Both From Date & Time and To Date & Time are required.")

    from_dt = get_datetime(from_datetime)
    to_dt = get_datetime(to_datetime)

    if to_dt < from_dt:
        frappe.throw("To Date & Time cannot be earlier than From Date & Time.")

    diff = to_dt - from_dt
    if diff.total_seconds() > (31 * 86400):
        days_diff = round(diff.total_seconds() / 86400, 1)
        frappe.throw(
            f"Maximum 31 days can be pulled in a single fetch. Selected range is {days_diff} days."
        )

    settings = _get_settings()
    if not settings:
        frappe.throw("Biometrics Settings are disabled or incomplete. Please check Biometrics Settings.")

    # Status Bar: Step 1 (10%)
    frappe.publish_progress(
        percent=10,
        title="Pulling Biometrics Records",
        description="Connecting to biometrics server and querying logs...",
    )

    conn = None
    start_time = time.time()

    try:
        table = settings.database_table or "dbo.EssLData"
        emp_col = settings.employee_code_field or "EmployeeCode"
        dt_col = settings.log_datetime_field or "LogDateTime"
        dev_col = settings.device_name_field or "DeviceName"

        emp_id_map, rfid_map = _get_employee_maps()

        conn = _get_mssql_connection(settings)
        cursor = conn.cursor(as_dict=True)

        target_codes = set()
        if employee:
            emp_data = frappe.db.get_value(
                "Employee",
                employee,
                ["name", "employee_number", "attendance_device_id"],
                as_dict=True,
            )
            if not emp_data:
                frappe.throw(f"Employee {employee} not found.")

            if emp_data.name:
                target_codes.add(str(emp_data.name).strip())
            if emp_data.get("employee_number"):
                target_codes.add(str(emp_data.employee_number).strip())
            if emp_data.get("attendance_device_id"):
                target_codes.add(str(emp_data.attendance_device_id).strip())

            placeholders = ", ".join(["%s"] * len(target_codes))
            query = (
                f"SELECT DISTINCT [{emp_col}] AS EmployeeCode, [{dt_col}] AS LogDateTime, "
                f"[{dev_col}] AS DeviceName FROM {table} "
                f"WHERE [{dt_col}] >= %s AND [{dt_col}] <= %s AND [{emp_col}] IN ({placeholders}) "
                f"ORDER BY [{dt_col}] ASC"
            )
            params = [from_dt, to_dt] + list(target_codes)
            cursor.execute(query, tuple(params))
        else:
            query = (
                f"SELECT DISTINCT [{emp_col}] AS EmployeeCode, [{dt_col}] AS LogDateTime, "
                f"[{dev_col}] AS DeviceName FROM {table} "
                f"WHERE [{dt_col}] >= %s AND [{dt_col}] <= %s "
                f"ORDER BY [{dt_col}] ASC"
            )
            cursor.execute(query, (from_dt, to_dt))

        logs = cursor.fetchall()
        cursor.close()

        total_fetched = len(logs)
        duration = round(time.time() - start_time, 2)

        if not logs:
            msg = f"No biometric logs found between {from_dt} and {to_dt}."
            if employee:
                msg += f" for employee {employee}"

            frappe.publish_progress(
                percent=100,
                title="Pulling Biometrics Records",
                description=msg,
            )

            _create_sync_log(
                sync_type="Manual",
                status="Success",
                total_logs_fetched=0,
                imported=0,
                skipped=0,
                message=msg,
                duration_seconds=duration,
            )
            frappe.msgprint(msg, indicator="blue")
            return {"imported": 0, "total_fetched": 0, "skipped_existing": 0}

        # Status Bar: Step 2 (30%)
        frappe.publish_progress(
            percent=30,
            title="Pulling Biometrics Records",
            description=f"Fetched {total_fetched} logs from server. Checking ERP records...",
        )

        existing_sql = """
            SELECT employee, time
            FROM `tabEmployee Checkin`
            WHERE time >= %s AND time <= %s
        """
        sql_params = [from_dt, to_dt]
        if employee:
            existing_sql += " AND employee = %s"
            sql_params.append(employee)

        existing_db = frappe.db.sql(existing_sql, tuple(sql_params), as_dict=True)
        existing_set = {(r.employee, str(r.time)) for r in existing_db}

        imported = 0
        skipped_existing = 0
        unmapped_codes = set()
        affected_pairs = set()
        progress_step = max(1, total_fetched // 20)

        # Status Bar: Step 3 (30% to 85%) - Processing loop
        for idx, log in enumerate(logs, 1):
            raw_code = log.get("EmployeeCode")
            raw_time = log.get("LogDateTime")
            device_name = (log.get("DeviceName") or "").strip()

            if not raw_code or not raw_time:
                continue

            emp_code = str(raw_code).strip()
            log_time = get_datetime(raw_time)

            # Priority 1: Check Employee ID in ERP, Priority 2: RFID
            matched_employee = emp_id_map.get(emp_code) or rfid_map.get(emp_code)
            if not matched_employee:
                unmapped_codes.add(emp_code)
                continue

            affected_pairs.add((matched_employee, str(getdate(log_time))))

            # Duplicate check: skip if this punch already exists in ERP
            key = (matched_employee, str(log_time))
            if key in existing_set:
                skipped_existing += 1
                continue

            checkin = frappe.new_doc("Employee Checkin")
            checkin.employee = matched_employee
            checkin.time = log_time
            checkin.device_id = device_name
            checkin.flags.ignore_in_out_hook = True
            checkin.insert(ignore_permissions=True)
            existing_set.add(key)
            imported += 1

            if idx % progress_step == 0 or idx == total_fetched:
                pct = 30 + int((idx / total_fetched) * 55)
                frappe.publish_progress(
                    percent=pct,
                    title="Pulling Biometrics Records",
                    description=f"Processing {idx} of {total_fetched} logs (Imported: {imported})...",
                )

        if imported > 0:
            frappe.db.commit()

        # Status Bar: Step 4 (85% to 95%) - Updating IN & OUT punch tags
        frappe.publish_progress(
            percent=90,
            title="Pulling Biometrics Records",
            description="Updating Punch In and Punch Out designations...",
        )

        min_gap = int(getattr(settings, "min_punch_gap_mins", 60) or 60)
        for emp, date_str in affected_pairs:
            update_in_out_for_employee_date(emp, date_str, min_gap)

        frappe.db.commit()

        duration = round(time.time() - start_time, 2)

        unmapped_list_str = ""
        if unmapped_codes:
            sorted_codes = sorted(unmapped_codes)
            unmapped_list_str = ", ".join(sorted_codes[:50])
            if len(sorted_codes) > 50:
                unmapped_list_str += f" (+{len(sorted_codes) - 50} more)"

        msg_parts = [
            f"Imported: {imported}",
            f"Already Existed: {skipped_existing}",
            f"Total Fetched: {total_fetched}",
        ]
        if unmapped_codes:
            msg_parts.append(f"Unmapped: {len(unmapped_codes)}")
        status_msg = " | ".join(msg_parts)

        # Status Bar: Step 5 (100% Complete)
        frappe.publish_progress(
            percent=100,
            title="Pulling Biometrics Records",
            description=f"Done! {status_msg}",
        )

        _create_sync_log(
            sync_type="Manual",
            status="Success",
            total_logs_fetched=total_fetched,
            imported=imported,
            skipped=skipped_existing + len(unmapped_codes),
            unmapped_count=len(unmapped_codes),
            unmapped_device_ids=unmapped_list_str,
            message=status_msg,
            duration_seconds=duration,
        )

        frappe.msgprint(
            f"<b>Manual Pull Complete:</b><br>{status_msg}",
            indicator="green" if imported > 0 else "blue",
            alert=True,
        )

        return {
            "imported": imported,
            "skipped_existing": skipped_existing,
            "total_fetched": total_fetched,
            "unmapped": len(unmapped_codes),
        }

    except Exception:
        duration = round(time.time() - start_time, 2)
        tb = frappe.get_traceback()
        frappe.db.rollback()
        _create_sync_log(
            sync_type="Manual",
            status="Failed",
            message=str(tb)[:500],
            error_traceback=tb,
            duration_seconds=duration,
        )
        frappe.log_error(title="Manual Biometrics Pull Failed", message=tb)
        raise

    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


@frappe.whitelist()
def recalculate_checkin_in_out(from_date=None, to_date=None, employee=None):
    """Re-evaluate and tag 'IN' and 'OUT' on existing Employee Checkins for a period."""
    if not from_date:
        from_date = nowdate()
    if not to_date:
        to_date = from_date

    settings = frappe.get_single("Biometrics Settings")
    min_gap = int(getattr(settings, "min_punch_gap_mins", 60) or 60)

    filters = {
        "time": ["between", [f"{from_date} 00:00:00", f"{to_date} 23:59:59"]]
    }
    if employee:
        filters["employee"] = employee

    checkins = frappe.get_all(
        "Employee Checkin",
        filters=filters,
        fields=["employee", "time"],
        limit_page_length=0,
    )

    if not checkins:
        frappe.msgprint("No checkins found for the specified period.", indicator="orange")
        return {"updated_count": 0}

    unique_pairs = {(c.employee, str(getdate(c.time))) for c in checkins}

    for emp, date_str in unique_pairs:
        update_in_out_for_employee_date(emp, date_str, min_gap)

    frappe.db.commit()
    msg = f"Updated IN/OUT designations for {len(unique_pairs)} employee-date records."
    frappe.msgprint(msg, indicator="green", alert=True)
    return {"updated_count": len(unique_pairs)}


def on_employee_checkin_update(doc, method=None):
    """Triggered when an Employee Checkin is created or modified manually in Desk."""
    if getattr(doc.flags, "ignore_in_out_hook", False):
        return

    if doc.employee and doc.time:
        settings = frappe.get_single("Biometrics Settings")
        min_gap = int(getattr(settings, "min_punch_gap_mins", 60) or 60)
        date_str = str(getdate(doc.time))
        update_in_out_for_employee_date(doc.employee, date_str, min_gap)


def on_employee_checkin_trash(doc, method=None):
    """Triggered when an Employee Checkin is deleted manually in Desk."""
    if getattr(doc.flags, "ignore_in_out_hook", False):
        return

    if doc.employee and doc.time:
        settings = frappe.get_single("Biometrics Settings")
        min_gap = int(getattr(settings, "min_punch_gap_mins", 60) or 60)
        date_str = str(getdate(doc.time))

        def _recalc():
            update_in_out_for_employee_date(doc.employee, date_str, min_gap)
            frappe.db.commit()

        frappe.db.after_commit(_recalc)

