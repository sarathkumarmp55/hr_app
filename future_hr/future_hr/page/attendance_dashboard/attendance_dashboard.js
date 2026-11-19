// Copyright (c) 2026, Future HR and contributors
// For license information, please see license.txt

frappe.pages["attendance-dashboard"].on_page_load = function (wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Attendance Live Dashboard"),
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

		// 2026 standard: 100 records per page default
		this.page_size = 100;
		this.current_page = 1;
		this.total_pages = 1;

		this.setup_ui();
		this.refresh();
		this.start_auto_refresh();
	}

	setup_ui() {
		const me = this;

		// Clean primary action button aligned with ERPNext 16 standard
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
				<!-- Metrics Summary Cards (2026 Modern Minimalist Style) -->
				<div class="att-metrics-grid">
					<div class="att-metric-card total" data-filter="ALL" title="${__("Click to filter All")}">
						<div class="att-metric-info">
							<span class="att-metric-title">${__("Total Active")}</span>
							<span class="att-metric-value" id="att-count-total">0</span>
						</div>
						<div class="att-metric-icon-wrap">
							<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
								<circle cx="9" cy="7" r="4"></circle>
								<path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
								<path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
							</svg>
						</div>
					</div>

					<div class="att-metric-card in" data-filter="CHECKED_IN" title="${__("Click to filter Inside Office")}">
						<div class="att-metric-info">
							<span class="att-metric-title">${__("Inside Office")}</span>
							<span class="att-metric-value" id="att-count-in">0</span>
						</div>
						<div class="att-metric-icon-wrap">
							<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
								<polyline points="10 17 15 12 10 7"></polyline>
								<line x1="15" y1="12" x2="3" y2="12"></line>
							</svg>
						</div>
					</div>

					<div class="att-metric-card out" data-filter="CHECKED_OUT" title="${__("Click to filter Checked Out")}">
						<div class="att-metric-info">
							<span class="att-metric-title">${__("Checked Out")}</span>
							<span class="att-metric-value" id="att-count-out">0</span>
						</div>
						<div class="att-metric-icon-wrap">
							<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
								<polyline points="16 17 21 12 16 7"></polyline>
								<line x1="21" y1="12" x2="9" y2="12"></line>
							</svg>
						</div>
					</div>

					<div class="att-metric-card absent" data-filter="NOT_IN" title="${__("Click to filter Not Arrived")}">
						<div class="att-metric-info">
							<span class="att-metric-title">${__("Not Arrived")}</span>
							<span class="att-metric-value" id="att-count-absent">0</span>
						</div>
						<div class="att-metric-icon-wrap">
							<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="10"></circle>
								<line x1="12" y1="8" x2="12" y2="12"></line>
								<line x1="12" y1="16" x2="12.01" y2="16"></line>
							</svg>
						</div>
					</div>
				</div>

				<!-- Control Toolbar (Unified Glassmorphism Card) -->
				<div class="att-toolbar">
					<div class="att-toolbar-left">
						<div class="att-search-box">
							<span class="att-search-icon">
								<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
									<circle cx="11" cy="11" r="8"></circle>
									<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
								</svg>
							</span>
							<input type="text" id="att-search-input" placeholder="${__("Search by name, ID, designation...")}" />
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
							<span class="att-pulse-radar"></span>
							<span>${__("Live")} (<span id="att-countdown">30</span>s)</span>
						</div>
					</div>
				</div>

				<!-- Table Card -->
				<div class="att-table-card">
					<div class="att-table-responsive">
						<table class="att-table">
							<thead>
								<tr>
									<th>${__("Employee")}</th>
									<th>${__("Designation & Dept")}</th>
									<th style="text-align: center; width: 190px;">${__("Punch In (First)")}</th>
									<th style="text-align: center; width: 190px;">${__("Punch Out (Last)")}</th>
									<th style="text-align: center; width: 150px;">${__("Live Status")}</th>
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

					<!-- Premium Pagination Bar (ERPNext 16 Style) -->
					<div class="att-pagination-bar" id="att-pagination-bar">
						<div class="att-pagination-info">
							<span id="att-page-info">Showing 0 of 0</span>
							<span class="att-page-size-wrap">
								<label for="att-page-size-select">${__("Per page")}:</label>
								<select id="att-page-size-select" class="att-select-sm">
									<option value="50">50</option>
									<option value="100" selected>100</option>
									<option value="200">200</option>
									<option value="500">500</option>
									<option value="9999">${__("All")}</option>
								</select>
							</span>
						</div>
						<div class="att-pagination-controls">
							<button class="att-page-btn" id="att-btn-prev" title="${__("Previous Page")}">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="15 18 9 12 15 6"></polyline>
								</svg>
								${__("Prev")}
							</button>
							<span class="att-page-display" id="att-page-display">Page 1 of 1</span>
							<button class="att-page-btn" id="att-btn-next" title="${__("Next Page")}">
								${__("Next")}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="9 18 15 12 9 6"></polyline>
								</svg>
							</button>
						</div>
					</div>
				</div>
			</div>
		`).appendTo(this.page.main);

		this.bind_events();
	}

	bind_events() {
		const me = this;

		// Instant Search
		this.$container.on("input", "#att-search-input", function () {
			me.search_query = $(this).val().toLowerCase().trim();
			me.current_page = 1;
			me.render_table();
		});

		// Filter Tabs
		this.$container.on("click", ".att-filter-btn", function () {
			me.$container.find(".att-filter-btn").removeClass("active");
			$(this).addClass("active");
			me.filter_status = $(this).data("filter");
			me.current_page = 1;
			me.render_table();
		});

		// Metric Cards Click
		this.$container.on("click", ".att-metric-card", function () {
			const filter = $(this).data("filter");
			if (filter) {
				me.filter_status = filter;
				me.current_page = 1;
				me.$container.find(".att-filter-btn").removeClass("active");
				me.$container.find(`.att-filter-btn[data-filter="${filter}"]`).addClass("active");
				me.render_table();
			}
		});

		// Date Picker Change
		this.$container.on("change", "#att-date-picker", function () {
			me.selected_date = $(this).val();
			me.current_page = 1;
			me.refresh();
		});

		// Pagination: Prev
		this.$container.on("click", "#att-btn-prev", function () {
			if (me.current_page > 1) {
				me.current_page--;
				me.render_table();
				me.scroll_to_table_top();
			}
		});

		// Pagination: Next
		this.$container.on("click", "#att-btn-next", function () {
			if (me.current_page < me.total_pages) {
				me.current_page++;
				me.render_table();
				me.scroll_to_table_top();
			}
		});

		// Pagination: Page Size Select
		this.$container.on("change", "#att-page-size-select", function () {
			me.page_size = parseInt($(this).val()) || 100;
			me.current_page = 1;
			me.render_table();
		});
	}

	scroll_to_table_top() {
		const $table = this.$container.find(".att-table-card");
		if ($table.length && $table[0].getBoundingClientRect().top < 0) {
			$table[0].scrollIntoView({ behavior: "smooth", block: "start" });
		}
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
						<div>${__("Fetching live biometric logs...")}</div>
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
			if (me.filter_status !== "ALL" && emp.status !== me.filter_status) {
				return false;
			}

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

		const total_records = filtered.length;
		this.total_pages = Math.ceil(total_records / this.page_size) || 1;

		if (this.current_page > this.total_pages) {
			this.current_page = this.total_pages;
		}

		if (total_records === 0) {
			$tbody.html(`
				<tr>
					<td colspan="5" class="att-empty-state">
						<div class="att-empty-icon">
							<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color: #94a3b8;">
								<circle cx="11" cy="11" r="8"></circle>
								<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
							</svg>
						</div>
						<div style="font-weight: 500; font-size: 14px;">${__("No employees found matching criteria.")}</div>
					</td>
				</tr>
			`);
			this.update_pagination_ui(0, 0, 0);
			return;
		}

		// Slice items for the current page
		const start_idx = (this.current_page - 1) * this.page_size;
		const end_idx = Math.min(start_idx + this.page_size, total_records);
		const page_items = filtered.slice(start_idx, end_idx);

		page_items.forEach((emp) => {
			const row = me.build_employee_row(emp);
			$tbody.append(row);
		});

		this.update_pagination_ui(start_idx + 1, end_idx, total_records);
	}

	update_pagination_ui(from, to, total) {
		const $bar = this.$container.find("#att-pagination-bar");
		if (total === 0) {
			$bar.hide();
			return;
		}
		$bar.show();

		this.$container.find("#att-page-info").text(
			__("Showing {0}–{1} of {2} employees", [from, to, total])
		);

		this.$container.find("#att-page-display").text(
			__("Page {0} of {1}", [this.current_page, this.total_pages])
		);

		// Prev / Next button states
		const $btnPrev = this.$container.find("#att-btn-prev");
		const $btnNext = this.$container.find("#att-btn-next");

		if (this.current_page <= 1) {
			$btnPrev.attr("disabled", true).addClass("disabled");
		} else {
			$btnPrev.removeAttr("disabled").removeClass("disabled");
		}

		if (this.current_page >= this.total_pages) {
			$btnNext.attr("disabled", true).addClass("disabled");
		} else {
			$btnNext.removeAttr("disabled").removeClass("disabled");
		}
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

		// ========================================================
		// 2026-LEVEL ARROW INDICATORS
		// Down Arrow SVG for IN, Up Arrow SVG for OUT
		// ========================================================

		const downArrowSvg = `
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
				<line x1="12" y1="5" x2="12" y2="19"></line>
				<polyline points="19 12 12 19 5 12"></polyline>
			</svg>
		`;

		const upArrowSvg = `
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
				<line x1="12" y1="19" x2="12" y2="5"></line>
				<polyline points="5 12 12 5 19 12"></polyline>
			</svg>
		`;

		let inArrowHtml = "";
		let outArrowHtml = "";
		let statusBadgeHtml = "";

		if (emp.status === "CHECKED_IN") {
			// Employee is inside: IN arrow pulses and blinks!
			inArrowHtml = `
				<div class="arrow-box arrow-in-blinking" title="${__("Checked In at")} ${emp.in_time}">
					<span class="arrow-icon-svg">${downArrowSvg}</span>
					<span class="arrow-time-text">${emp.in_time || "IN"}</span>
				</div>
			`;
			outArrowHtml = `
				<div class="arrow-box arrow-inactive" title="${__("Not checked out yet")}">
					<span class="arrow-icon-svg">${upArrowSvg}</span>
					<span class="arrow-time-text">--:--</span>
				</div>
			`;
			statusBadgeHtml = `
				<span class="att-status-badge status-in">
					<span class="status-dot"></span>
					${__("Inside")}
				</span>
			`;
		} else if (emp.status === "CHECKED_OUT") {
			// Employee checked out: OUT arrow pulses and blinks! IN arrow is solid completed
			inArrowHtml = `
				<div class="arrow-box arrow-in-solid" title="${__("First In at")} ${emp.in_time}">
					<span class="arrow-icon-svg">${downArrowSvg}</span>
					<span class="arrow-time-text">${emp.in_time || "IN"}</span>
				</div>
			`;
			outArrowHtml = `
				<div class="arrow-box arrow-out-blinking" title="${__("Checked Out at")} ${emp.out_time}">
					<span class="arrow-icon-svg">${upArrowSvg}</span>
					<span class="arrow-time-text">${emp.out_time || "OUT"}</span>
				</div>
			`;
			statusBadgeHtml = `
				<span class="att-status-badge status-out">
					<span class="status-dot"></span>
					${__("Checked Out")}
				</span>
			`;
		} else {
			// Not checked in yet
			inArrowHtml = `
				<div class="arrow-box arrow-inactive" title="${__("No punch recorded today")}">
					<span class="arrow-icon-svg">${downArrowSvg}</span>
					<span class="arrow-time-text">--:--</span>
				</div>
			`;
			outArrowHtml = `
				<div class="arrow-box arrow-inactive" title="${__("No punch recorded today")}">
					<span class="arrow-icon-svg">${upArrowSvg}</span>
					<span class="arrow-time-text">--:--</span>
				</div>
			`;
			statusBadgeHtml = `
				<span class="att-status-badge status-absent">
					<span class="status-dot"></span>
					${__("Not In")}
				</span>
			`;
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
					${
						emp.department
							? `<div class="att-desig-dept">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
										<path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
									</svg>
									${frappe.utils.escape_html(emp.department)}
							   </div>`
							: ""
					}
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
