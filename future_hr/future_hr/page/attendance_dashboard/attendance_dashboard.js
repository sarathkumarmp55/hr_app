// Copyright (c) 2026, Future HR and contributors
// For license information, please see license.txt

frappe.pages["attendance-dashboard"].on_page_load = function (wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Attendance Dashboard"),
		single_column: true,
	});

	wrapper.attendance_dashboard = new AttendanceDashboard(page);
};

frappe.pages["attendance-dashboard"].on_page_show = function (wrapper) {
	if (wrapper.attendance_dashboard) {
		wrapper.attendance_dashboard.refresh();
		wrapper.attendance_dashboard.start_auto_refresh();
	}
};

frappe.pages["attendance-dashboard"].on_page_hide = function (wrapper) {
	if (wrapper.attendance_dashboard) {
		wrapper.attendance_dashboard.stop_auto_refresh();
	}
};

class AttendanceDashboard {
	constructor(page) {
		this.page = page;
		this.selected_date = frappe.datetime.get_today();
		this.filter_status = "ALL";
		this.search_query = "";
		this.employees = [];
		this.summary = { total: 0, checked_in: 0, checked_out: 0, not_in: 0 };
		this.refresh_interval = null;
		this.auto_refresh_secs = 30;
		this.countdown = 30;

		this.setup_ui();
		this.refresh();
		this.start_auto_refresh();
	}

	setup_ui() {
		const me = this;

		// Primary Refresh Button
		this.page.set_primary_action(
			__("Refresh"),
			function () {
				me.refresh();
			},
			"refresh"
		);

		// Container
		this.$container = $(`
			<div class="attendance-dashboard-wrapper">
				<!-- Metrics Summary Cards -->
				<div class="att-metrics-grid">
					<div class="att-metric-card total" data-filter="ALL">
						<div class="att-metric-info">
							<span class="att-metric-title">${__("Total Active")}</span>
							<span class="att-metric-value" id="att-count-total">0</span>
						</div>
						<div class="att-metric-icon">👥</div>
					</div>
					<div class="att-metric-card in" data-filter="CHECKED_IN">
						<div class="att-metric-info">
							<span class="att-metric-title">${__("Inside Office")}</span>
							<span class="att-metric-value" id="att-count-in">0</span>
						</div>
						<div class="att-metric-icon">🟢</div>
					</div>
					<div class="att-metric-card out" data-filter="CHECKED_OUT">
						<div class="att-metric-info">
							<span class="att-metric-title">${__("Checked Out")}</span>
							<span class="att-metric-value" id="att-count-out">0</span>
						</div>
						<div class="att-metric-icon">🔴</div>
					</div>
					<div class="att-metric-card absent" data-filter="NOT_IN">
						<div class="att-metric-info">
							<span class="att-metric-title">${__("Not Arrived")}</span>
							<span class="att-metric-value" id="att-count-absent">0</span>
						</div>
						<div class="att-metric-icon">⚪</div>
					</div>
				</div>

				<!-- Toolbar -->
				<div class="att-toolbar">
					<div class="att-toolbar-left">
						<div class="att-search-box">
							<span class="att-search-icon">🔍</span>
							<input type="text" id="att-search-input" placeholder="${__("Search by Name, ID, Designation...")}" />
						</div>

						<div class="att-filter-group">
							<button class="att-filter-btn active" data-filter="ALL">
								${__("All")} <span class="att-filter-count" id="badge-all">0</span>
							</button>
							<button class="att-filter-btn" data-filter="CHECKED_IN">
								${__("Inside")} <span class="att-filter-count" id="badge-in">0</span>
							</button>
							<button class="att-filter-btn" data-filter="CHECKED_OUT">
								${__("Out")} <span class="att-filter-count" id="badge-out">0</span>
							</button>
							<button class="att-filter-btn" data-filter="NOT_IN">
								${__("Not In")} <span class="att-filter-count" id="badge-absent">0</span>
							</button>
						</div>
					</div>

					<div class="att-toolbar-right">
						<input type="date" id="att-date-picker" class="att-date-picker" value="${this.selected_date}" />
						<div class="att-live-status">
							<span class="att-pulse-dot"></span>
							<span id="att-live-text">${__("Live")} (<span id="att-countdown">30</span>s)</span>
						</div>
					</div>
				</div>

				<!-- Employees Attendance Table -->
				<div class="att-table-card">
					<div class="att-table-responsive">
						<table class="att-table">
							<thead>
								<tr>
									<th>${__("Employee")}</th>
									<th>${__("Designation & Dept")}</th>
									<th style="text-align: center; width: 180px;">${__("Punch In (First)")}</th>
									<th style="text-align: center; width: 180px;">${__("Punch Out (Last)")}</th>
									<th style="text-align: center; width: 140px;">${__("Status")}</th>
								</tr>
							</thead>
							<tbody id="att-table-body">
								<tr>
									<td colspan="5" class="att-empty-state">
										<div class="att-empty-icon">⏳</div>
										<div>${__("Loading attendance data...")}</div>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
				</div>
			</div>
		`).appendTo(this.page.main);

		this.bind_events();
	}

	bind_events() {
		const me = this;

		// Search input
		this.$container.on("input", "#att-search-input", function () {
			me.search_query = $(this).val().toLowerCase().trim();
			me.render_table();
		});

		// Filter buttons
		this.$container.on("click", ".att-filter-btn", function () {
			me.$container.find(".att-filter-btn").removeClass("active");
			$(this).addClass("active");
			me.filter_status = $(this).data("filter");
			me.render_table();
		});

		// Metric cards click to filter
		this.$container.on("click", ".att-metric-card", function () {
			const filter = $(this).data("filter");
			if (filter) {
				me.filter_status = filter;
				me.$container.find(".att-filter-btn").removeClass("active");
				me.$container.find(`.att-filter-btn[data-filter="${filter}"]`).addClass("active");
				me.render_table();
			}
		});

		// Date picker change
		this.$container.on("change", "#att-date-picker", function () {
			me.selected_date = $(this).val();
			me.refresh();
		});
	}

	start_auto_refresh() {
		this.stop_auto_refresh();
		this.countdown = this.auto_refresh_secs;

		this.refresh_interval = setInterval(() => {
			this.countdown--;
			this.$container.find("#att-countdown").text(this.countdown);

			if (this.countdown <= 0) {
				this.countdown = this.auto_refresh_secs;
				this.refresh(true); // background silent refresh
			}
		}, 1000);
	}

	stop_auto_refresh() {
		if (this.refresh_interval) {
			clearInterval(this.refresh_interval);
			this.refresh_interval = null;
		}
	}

	refresh(silent = false) {
		const me = this;
		if (!silent) {
			this.$container.find("#att-table-body").html(`
				<tr>
					<td colspan="5" class="att-empty-state">
						<div class="att-empty-icon">⏳</div>
						<div>${__("Fetching live attendance logs...")}</div>
					</td>
				</tr>
			`);
		}

		frappe.call({
			method: "future_hr.future_hr.page.attendance_dashboard.attendance_dashboard.get_attendance_data",
			args: {
				date: me.selected_date,
			},
			callback: function (r) {
				if (r.message) {
					me.employees = r.message.employees || [];
					me.summary = r.message.summary || { total: 0, checked_in: 0, checked_out: 0, not_in: 0 };
					me.update_metrics();
					me.render_table();
				}
			},
		});
	}

	update_metrics() {
		this.$container.find("#att-count-total").text(this.summary.total);
		this.$container.find("#att-count-in").text(this.summary.checked_in);
		this.$container.find("#att-count-out").text(this.summary.checked_out);
		this.$container.find("#att-count-absent").text(this.summary.not_in);

		this.$container.find("#badge-all").text(this.summary.total);
		this.$container.find("#badge-in").text(this.summary.checked_in);
		this.$container.find("#badge-out").text(this.summary.checked_out);
		this.$container.find("#badge-absent").text(this.summary.not_in);
	}

	render_table() {
		const me = this;
		const $tbody = this.$container.find("#att-table-body");
		$tbody.empty();

		const filtered = this.employees.filter((emp) => {
			// Status filter
			if (me.filter_status !== "ALL" && emp.status !== me.filter_status) {
				return false;
			}

			// Text search
			if (me.search_query) {
				const id = (emp.employee_id || "").toLowerCase();
				const name = (emp.employee_name || "").toLowerCase();
				const desig = (emp.designation || "").toLowerCase();
				const dept = (emp.department || "").toLowerCase();

				if (
					!id.includes(me.search_query) &&
					!name.includes(me.search_query) &&
					!desig.includes(me.search_query) &&
					!dept.includes(me.search_query)
				) {
					return false;
				}
			}

			return true;
		});

		if (filtered.length === 0) {
			$tbody.html(`
				<tr>
					<td colspan="5" class="att-empty-state">
						<div class="att-empty-icon">📋</div>
						<div>${__("No employees match the current filter or search criteria.")}</div>
					</td>
				</tr>
			`);
			return;
		}

		filtered.forEach((emp) => {
			const row = me.build_employee_row(emp);
			$tbody.append(row);
		});
	}

	build_employee_row(emp) {
		const initials = (emp.employee_name || "E")
			.split(" ")
			.map((n) => n[0])
			.slice(0, 2)
			.join("")
			.toUpperCase();

		const avatarHtml = emp.image
			? `<img class="att-avatar" src="${emp.image}" alt="${frappe.utils.escape_html(emp.employee_name)}" />`
			: `<div class="att-avatar-initials">${initials}</div>`;

		// ============================================
		// ARROW INDICATORS LOGIC:
		// 1. When checked in (inside now):
		//    - IN arrow blinks green (⬇ IN 09:15 AM)
		//    - OUT arrow is dimmed inactive (⬆ --:--)
		// 2. When checked out (has left office):
		//    - IN arrow is solid green (⬇ IN 09:15 AM)
		//    - OUT arrow blinks red (⬆ OUT 06:30 PM)
		// 3. When not arrived yet:
		//    - Both arrows are dimmed inactive
		// ============================================

		let inArrowHtml = "";
		let outArrowHtml = "";
		let statusBadgeHtml = "";

		if (emp.status === "CHECKED_IN") {
			// Employee is inside: IN arrow blinks!
			inArrowHtml = `
				<div class="arrow-box arrow-in-blinking" title="${__("Checked In at")} ${emp.in_time}">
					<span class="arrow-symbol">⬇</span>
					<span>${emp.in_time || __("IN")}</span>
				</div>
			`;
			outArrowHtml = `
				<div class="arrow-box arrow-inactive" title="${__("Not checked out yet")}">
					<span class="arrow-symbol">⬆</span>
					<span>--:--</span>
				</div>
			`;
			statusBadgeHtml = `<span class="att-status-badge status-in">${__("Inside Office")}</span>`;
		} else if (emp.status === "CHECKED_OUT") {
			// Employee checked out: OUT arrow blinks! IN arrow is solid
			inArrowHtml = `
				<div class="arrow-box arrow-in-solid" title="${__("First In at")} ${emp.in_time}">
					<span class="arrow-symbol">⬇</span>
					<span>${emp.in_time || __("IN")}</span>
				</div>
			`;
			outArrowHtml = `
				<div class="arrow-box arrow-out-blinking" title="${__("Checked Out at")} ${emp.out_time}">
					<span class="arrow-symbol">⬆</span>
					<span>${emp.out_time || __("OUT")}</span>
				</div>
			`;
			statusBadgeHtml = `<span class="att-status-badge status-out">${__("Checked Out")}</span>`;
		} else {
			// Not checked in yet
			inArrowHtml = `
				<div class="arrow-box arrow-inactive" title="${__("No punch recorded today")}">
					<span class="arrow-symbol">⬇</span>
					<span>--:--</span>
				</div>
			`;
			outArrowHtml = `
				<div class="arrow-box arrow-inactive" title="${__("No punch recorded today")}">
					<span class="arrow-symbol">⬆</span>
					<span>--:--</span>
				</div>
			`;
			statusBadgeHtml = `<span class="att-status-badge status-absent">${__("Not Arrived")}</span>`;
		}

		return $(`
			<tr>
				<td>
					<div class="att-emp-cell">
						${avatarHtml}
						<div class="att-emp-details">
							<a href="/app/employee/${encodeURIComponent(emp.employee_id)}" class="att-emp-name" target="_blank">
								${frappe.utils.escape_html(emp.employee_name)}
							</a>
							<span class="att-emp-id">${frappe.utils.escape_html(emp.employee_id)}</span>
						</div>
					</div>
				</td>
				<td>
					<div class="att-desig-title">${frappe.utils.escape_html(emp.designation)}</div>
					${emp.department ? `<div class="att-desig-dept">${frappe.utils.escape_html(emp.department)}</div>` : ""}
				</td>
				<td style="text-align: center;">
					${inArrowHtml}
				</td>
				<td style="text-align: center;">
					${outArrowHtml}
				</td>
				<td style="text-align: center;">
					${statusBadgeHtml}
				</td>
			</tr>
		`);
	}
}
