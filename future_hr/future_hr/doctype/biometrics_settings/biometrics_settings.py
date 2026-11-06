# Copyright (c) 2026, Future HR and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class BiometricsSettings(Document):
    def validate(self):
        if self.enabled and not self.server:
            frappe.throw("Server IP / Hostname is required when sync is enabled.")
        if self.enabled and not self.db_password:
            frappe.throw("Database Password is required when sync is enabled.")
        if self.port and (self.port < 1 or self.port > 65535):
            frappe.throw("Port must be between 1 and 65535.")


@frappe.whitelist()
def test_connection():
    """Test MSSQL connection with the configured credentials."""
    settings = frappe.get_single("Biometrics Settings")
    try:
        import pymssql

        conn = pymssql.connect(
            server=settings.server,
            port=int(settings.port or 1433),
            user=settings.db_user,
            password=settings.get_password("db_password"),
            login_timeout=int(settings.login_timeout or 30),
            timeout=int(settings.query_timeout or 60),
        )
        conn.close()
        frappe.msgprint("Connection successful!", indicator="green", alert=True)
    except ImportError:
        frappe.throw("pymssql is not installed. Run: pip install pymssql")
    except Exception as e:
        frappe.throw(f"Connection failed: {str(e)}")


@frappe.whitelist()
def sync_now():
    """Manually trigger an attendance sync (incremental using watermark)."""
    from future_hr.events.employee_checkin import sync_attendance_logs

    sync_attendance_logs(sync_type="Manual")
    frappe.msgprint("Sync completed. Check Biometrics Sync Log for details.", indicator="blue", alert=True)


@frappe.whitelist()
def manual_pull_records(from_datetime, to_datetime, employee=None):
    """Manually pull attendance logs with date/time range and optional employee (max 31 days)."""
    from future_hr.events.employee_checkin import pull_manual_attendance_logs

    return pull_manual_attendance_logs(
        from_datetime=from_datetime,
        to_datetime=to_datetime,
        employee=employee,
    )


@frappe.whitelist()
def recalculate_in_out(from_date=None, to_date=None, employee=None):
    """Recalculate IN / OUT on existing checkins based on punch rules."""
    from future_hr.events.employee_checkin import recalculate_checkin_in_out

    return recalculate_checkin_in_out(
        from_date=from_date,
        to_date=to_date,
        employee=employee,
    )
