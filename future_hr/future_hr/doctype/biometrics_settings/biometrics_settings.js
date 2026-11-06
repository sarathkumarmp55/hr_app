// Copyright (c) 2026, Future HR and contributors
// For license information, please see license.txt

frappe.ui.form.on("Biometrics Settings", {
    refresh(frm) {
        // 1. Test Connection Button
        frm.add_custom_button(__("Test Connection"), function () {
            frappe.show_alert({ message: __("Testing connection..."), indicator: "blue" });
            frappe.call({
                method: "future_hr.future_hr.doctype.biometrics_settings.biometrics_settings.test_connection",
                freeze: true,
                freeze_message: __("Testing connection...")
            });
        }).addClass("btn-default");

        // 2. Incremental Sync Now Button (with status bar)
        frm.add_custom_button(__("Sync Now"), function () {
            frappe.confirm(
                __("This will sync new attendance logs from the biometrics server using the watermark. Continue?"),
                function () {
                    frappe.show_progress(__("Syncing Attendance Logs"), 15, 100, __("Connecting to biometrics server..."));
                    frappe.call({
                        method: "future_hr.future_hr.doctype.biometrics_settings.biometrics_settings.sync_now",
                        callback: function () {
                            frappe.show_progress(__("Syncing Attendance Logs"), 100, 100, __("Sync complete!"), true);
                            frm.reload_doc();
                        },
                        error: function () {
                            frappe.hide_progress();
                        }
                    });
                }
            );
        }).addClass("btn-primary");

        // 3. Manual Pull (Dialog with Date/Time range + Employee + Max 31 Days Validation)
        frm.add_custom_button(__("Manual Pull"), function () {
            open_manual_pull_dialog(frm);
        });

        // 4. Recalculate IN / OUT on existing checkins
        frm.add_custom_button(__("Recalculate IN/OUT"), function () {
            open_recalculate_dialog(frm);
        });
    },

    // 5. Form Section Button: "Fetch Records" (with status bar)
    btn_manual_fetch(frm) {
        let from_dt = frm.doc.manual_from_datetime;
        let to_dt = frm.doc.manual_to_datetime;
        let emp = frm.doc.manual_employee;

        if (!from_dt || !to_dt) {
            frappe.msgprint({
                title: __("Missing Fields"),
                message: __("Please enter both <b>From Date & Time</b> and <b>To Date & Time</b>."),
                indicator: "orange"
            });
            return;
        }

        if (!validate_31_days(from_dt, to_dt)) {
            return;
        }

        execute_manual_pull(from_dt, to_dt, emp, function () {
            frm.reload_doc();
        });
    }
});

function open_manual_pull_dialog(frm) {
    let now = frappe.datetime.now_datetime();
    let yesterday = frappe.datetime.add_days(now, -1);

    let d = new frappe.ui.Dialog({
        title: __("Manual Pull Biometrics Records"),
        fields: [
            {
                fieldname: "from_datetime",
                fieldtype: "Datetime",
                label: __("From Date & Time"),
                default: yesterday,
                reqd: 1
            },
            {
                fieldname: "to_datetime",
                fieldtype: "Datetime",
                label: __("To Date & Time"),
                default: now,
                reqd: 1
            },
            {
                fieldname: "employee",
                fieldtype: "Link",
                options: "Employee",
                label: __("Employee (Optional)"),
                description: __("Leave blank to pull records for all employees")
            }
        ],
        primary_action_label: __("Pull Records"),
        primary_action(values) {
            if (!validate_31_days(values.from_datetime, values.to_datetime)) {
                return;
            }

            d.hide();
            execute_manual_pull(values.from_datetime, values.to_datetime, values.employee, function () {
                frm.reload_doc();
            });
        }
    });

    d.show();
}

function open_recalculate_dialog(frm) {
    let today = frappe.datetime.get_today();

    let d = new frappe.ui.Dialog({
        title: __("Recalculate Punch In & Punch Out"),
        fields: [
            {
                fieldname: "from_date",
                fieldtype: "Date",
                label: __("From Date"),
                default: today,
                reqd: 1
            },
            {
                fieldname: "to_date",
                fieldtype: "Date",
                label: __("To Date"),
                default: today,
                reqd: 1
            },
            {
                fieldname: "employee",
                fieldtype: "Link",
                options: "Employee",
                label: __("Employee (Optional)")
            }
        ],
        primary_action_label: __("Recalculate"),
        primary_action(values) {
            d.hide();
            frappe.call({
                method: "future_hr.future_hr.doctype.biometrics_settings.biometrics_settings.recalculate_in_out",
                args: values,
                freeze: true,
                freeze_message: __("Updating Punch In and Punch Out designations..."),
                callback: function (r) {
                    frm.reload_doc();
                }
            });
        }
    });

    d.show();
}

function validate_31_days(from_dt, to_dt) {
    let from_m = moment(from_dt);
    let to_m = moment(to_dt);

    if (to_m.isBefore(from_m)) {
        frappe.msgprint({
            title: __("Invalid Date Range"),
            message: __("<b>To Date & Time</b> cannot be earlier than <b>From Date & Time</b>."),
            indicator: "red"
        });
        return false;
    }

    let diff_days = to_m.diff(from_m, "days", true);
    if (diff_days > 31) {
        frappe.msgprint({
            title: __("Range Limit Exceeded"),
            message: __(
                "A maximum of <b>31 days</b> can be pulled in a single fetch.<br>Selected range is <b>{0} days</b>. Please reduce the date range.",
                [diff_days.toFixed(1)]
            ),
            indicator: "red"
        });
        return false;
    }

    return true;
}

function execute_manual_pull(from_datetime, to_datetime, employee, callback) {
    frappe.show_progress(__("Pulling Biometrics Records"), 10, 100, __("Connecting to server and querying logs..."));

    frappe.call({
        method: "future_hr.future_hr.doctype.biometrics_settings.biometrics_settings.manual_pull_records",
        args: {
            from_datetime: from_datetime,
            to_datetime: to_datetime,
            employee: employee || ""
        },
        callback: function (r) {
            frappe.show_progress(__("Pulling Biometrics Records"), 100, 100, __("Pull complete!"), true);
            if (callback) callback();
        },
        error: function () {
            frappe.hide_progress();
        }
    });
}
