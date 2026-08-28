export const BROWSER_AGENT_BENCHMARK_CORPUS_VERSION = "1.1.0";

const target = (role, name) => ({ role, name });
const navigate = (path, site = "primary") => ({ op: "navigate", site, path });
const click = (role, name, extra = {}) => ({
	op: "click",
	target: target(role, name),
	...extra,
});
const type = (role, name, text, extra = {}) => ({
	op: "type",
	target: target(role, name),
	text,
	...extra,
});

function researchWorkflow({
	id,
	title,
	objective,
	sourceA,
	sourceB,
	answerLabel,
	answer,
	screenshot = false,
}) {
	const steps = [
		navigate("/start"),
		click("link", sourceA.label),
		{ op: "observe-text", text: sourceA.fact },
		navigate("/start"),
		click("link", sourceB.label),
		{ op: "observe-text", text: sourceB.fact },
		navigate("/start"),
	];
	if (screenshot) steps.push({ op: "screenshot" });
	steps.push(
		type("textbox", answerLabel, answer),
		click("button", "Save verified finding"),
	);
	return {
		id,
		version: 1,
		category: "research",
		title,
		objective,
		expectedOutcome: "completed",
		pages: [
			{
				site: "primary",
				path: "/start",
				title,
				heading: title,
				text: [
					"Fixture data only. Inspect both bounded sources before saving the finding.",
				],
				links: [
					{ label: sourceA.label, site: "secondary", path: "/source-a" },
					{ label: sourceB.label, site: "secondary", path: "/source-b" },
				],
				fields: [
					{
						kind: "text",
						name: "finding",
						label: answerLabel,
						required: true,
					},
				],
				controls: [
					{
						id: "save-finding",
						label: "Save verified finding",
						kind: "submit",
						resultText: "Finding saved",
					},
				],
			},
			{
				site: "secondary",
				path: "/source-a",
				title: sourceA.label,
				heading: sourceA.label,
				text: [sourceA.fact],
			},
			{
				site: "secondary",
				path: "/source-b",
				title: sourceB.label,
				heading: sourceB.label,
				text: [sourceB.fact],
			},
		],
		steps,
		predicates: [
			{ kind: "visited", site: "secondary", path: "/source-a", minimum: 1 },
			{ kind: "visited", site: "secondary", path: "/source-b", minimum: 1 },
			{ kind: "field", name: "finding", equals: answer },
			{ kind: "activation", id: "save-finding", equals: 1 },
		],
	};
}

function fieldStep(field) {
	if (field.kind === "text" || field.kind === "textarea")
		return type("textbox", field.label, field.benchmarkValue);
	if (field.kind === "select")
		return {
			op: "select",
			target: target("combobox", field.label),
			value: field.options[field.benchmarkIndex].value,
		};
	if (field.kind === "checkbox")
		return click("checkbox", field.label);
	if (field.kind === "radio")
		return click("radio", field.benchmarkLabel ?? field.benchmarkValue);
	if (field.kind === "file")
		return {
			op: "upload",
			selector: `input[name=${JSON.stringify(field.name)}]`,
			paths: [field.benchmarkValue],
		};
	throw new Error(`Unsupported benchmark field kind: ${field.kind}`);
}

function fieldPredicate(field) {
	return {
		kind: "field",
		name: field.name,
		equals:
			field.kind === "checkbox"
				? true
				: field.kind === "select"
					? field.options[field.benchmarkIndex].value
					: field.benchmarkValue,
	};
}

function formWorkflow({
	id,
	category = "forms",
	title,
	objective,
	fields,
	control = {
		id: "submit",
		label: "Submit fixture",
		kind: "submit",
		resultText: "Submitted",
	},
	text = ["Local deterministic fixture. No external submission is performed."],
	additionalControls = [],
	additionalPredicates = [],
	stepsBeforeSubmit = [],
	stepsAfterSubmit = [],
	page = {},
}) {
	return {
		id,
		version: 1,
		category,
		title,
		objective,
		expectedOutcome: "completed",
		pages: [
			{
				site: "primary",
				path: "/start",
				title,
				heading: title,
				text,
				fields: fields.map(({ benchmarkValue, benchmarkIndex, ...field }) =>
					field,
				),
				controls: [control, ...additionalControls],
				...page,
			},
		],
		steps: [
			navigate("/start"),
			...fields.map(fieldStep),
			...stepsBeforeSubmit,
			click("button", control.label),
			...stepsAfterSubmit,
		],
		predicates: [
			...fields.map(fieldPredicate),
			{ kind: "activation", id: control.id, equals: 1 },
			...additionalPredicates,
		],
	};
}

const research = [
	{
		id: "research-compare-laptop-prices",
		title: "Compare two laptop prices",
		objective: "Read two fixture product sources and save the lower current price.",
		sourceA: {
			label: "Falcon 13 product page",
			fact: "Falcon 13 current fixture price: $899.",
		},
		sourceB: {
			label: "Harbor 14 product page",
			fact: "Harbor 14 current fixture price: $1,099.",
		},
		answerLabel: "Best option and price",
		answer: "Falcon 13 — $899",
		screenshot: true,
	},
	{
		id: "research-find-event-time",
		title: "Find an event start time",
		objective: "Cross-check the schedule and registration notice for the event time.",
		sourceA: {
			label: "Official workshop schedule",
			fact: "The browser reliability workshop starts Thursday at 9:30 AM.",
		},
		sourceB: {
			label: "Registration notice",
			fact: "Doors open at 9:00 AM; the workshop begins at 9:30 AM.",
		},
		answerLabel: "Verified event time",
		answer: "Thursday at 9:30 AM",
	},
	{
		id: "research-identify-current-docs",
		title: "Identify current official documentation",
		objective: "Distinguish the current fixture docs from an archived version.",
		sourceA: {
			label: "Current SDK documentation",
			fact: "Current stable Kestrel fixture SDK version: v4.2.",
		},
		sourceB: {
			label: "Archived SDK notes",
			fact: "Archive notice: v3.8 is no longer the current stable version.",
		},
		answerLabel: "Current version",
		answer: "v4.2",
	},
	{
		id: "research-grant-deadline",
		title: "Verify a grant deadline",
		objective: "Read the fixture call and FAQ before recording the deadline.",
		sourceA: {
			label: "Grant call",
			fact: "Applications close September 18, 2026 at 5:00 PM CT.",
		},
		sourceB: {
			label: "Grant FAQ",
			fact: "The FAQ confirms the September 18 deadline uses Central Time.",
		},
		answerLabel: "Verified deadline",
		answer: "September 18, 2026 at 5:00 PM CT",
	},
	{
		id: "research-train-arrival",
		title: "Compare train arrival options",
		objective: "Find the fixture train that arrives before the stated cutoff.",
		sourceA: {
			label: "Northbound timetable",
			fact: "Train N12 arrives at 6:40 PM and costs $46.",
		},
		sourceB: {
			label: "Express timetable",
			fact: "Train X8 arrives at 7:25 PM and costs $39.",
		},
		answerLabel: "Option arriving before 7 PM",
		answer: "Train N12 — 6:40 PM",
	},
	{
		id: "research-camera-battery",
		title: "Compare camera battery life",
		objective: "Cross-check two fixture specifications and save the longer rating.",
		sourceA: {
			label: "Oriole camera specifications",
			fact: "Oriole C2 rated battery life: 420 shots.",
		},
		sourceB: {
			label: "Juniper camera specifications",
			fact: "Juniper M5 rated battery life: 510 shots.",
		},
		answerLabel: "Longer battery rating",
		answer: "Juniper M5 — 510 shots",
	},
	{
		id: "research-conference-venue",
		title: "Confirm a conference venue",
		objective: "Verify the fixture venue using the program and attendee guide.",
		sourceA: {
			label: "Conference program",
			fact: "The opening session is in Lakeside Hall, Room 204.",
		},
		sourceB: {
			label: "Attendee guide",
			fact: "Lakeside Hall Room 204 is on the second floor.",
		},
		answerLabel: "Verified venue",
		answer: "Lakeside Hall, Room 204",
	},
	{
		id: "research-refund-window",
		title: "Verify a refund window",
		objective: "Read policy and help fixtures before recording the allowed window.",
		sourceA: {
			label: "Official refund policy",
			fact: "Fixture purchases may be returned within 30 calendar days.",
		},
		sourceB: {
			label: "Returns help article",
			fact: "The 30-day window begins on the delivery date.",
		},
		answerLabel: "Verified return window",
		answer: "30 calendar days from delivery",
	},
	{
		id: "research-api-rate-limit",
		title: "Find an API rate limit",
		objective: "Confirm the fixture API limit using reference and changelog pages.",
		sourceA: {
			label: "API limits reference",
			fact: "Standard fixture projects allow 120 requests per minute.",
		},
		sourceB: {
			label: "API changelog",
			fact: "The standard limit increased from 100 to 120 requests per minute.",
		},
		answerLabel: "Current standard limit",
		answer: "120 requests per minute",
	},
	{
		id: "research-course-prerequisites",
		title: "Collect course prerequisites",
		objective: "Reconcile the catalog and department notice for prerequisites.",
		sourceA: {
			label: "Course catalog entry",
			fact: "Fixture course CS 240 requires CS 120 and one statistics course.",
		},
		sourceB: {
			label: "Department prerequisite note",
			fact: "STAT 101 satisfies the statistics prerequisite for CS 240.",
		},
		answerLabel: "Verified prerequisites",
		answer: "CS 120 and a statistics course such as STAT 101",
	},
].map(researchWorkflow);

const forms = [
	formWorkflow({
		id: "forms-simple-contact",
		title: "Fill a simple contact form",
		objective: "Complete required name and email fields on a local fixture.",
		fields: [
			{ kind: "text", name: "name", label: "Full name", required: true, benchmarkValue: "Aria Chen" },
			{ kind: "text", name: "email", label: "Email address", required: true, benchmarkValue: "aria@example.test" },
		],
		stepsBeforeSubmit: [
			{
				op: "expect-approval-block",
				action: { type: "click", target: target("button", "Submit fixture") },
				predicates: [{ kind: "activation", id: "submit", equals: 0 }],
			},
		],
	}),
	{
		id: "forms-multi-page-application",
		version: 1,
		category: "forms",
		title: "Complete a two-page application",
		objective: "Carry fixture application data through review and final submission.",
		expectedOutcome: "completed",
		pages: [
			{
				site: "primary",
				path: "/start",
				title: "Application basics",
				heading: "Application basics",
				fields: [{ kind: "text", name: "project", label: "Project name", required: true }],
				controls: [{ id: "next", label: "Continue to details", kind: "submit", navigate: { site: "primary", path: "/details" } }],
			},
			{
				site: "primary",
				path: "/details",
				title: "Application details",
				heading: "Application details",
				fields: [{ kind: "textarea", name: "summary", label: "Project summary", required: true }],
				controls: [{ id: "submit", label: "Submit fixture application", kind: "submit", resultText: "Application submitted" }],
			},
		],
		steps: [
			navigate("/start"),
			type("textbox", "Project name", "Kestrel reliability study"),
			click("button", "Continue to details"),
			type("textbox", "Project summary", "A deterministic browser reliability benchmark."),
			click("button", "Submit fixture application"),
		],
		predicates: [
			{ kind: "field", name: "project", equals: "Kestrel reliability study" },
			{ kind: "field", name: "summary", equals: "A deterministic browser reliability benchmark." },
			{ kind: "activation", id: "next", equals: 1 },
			{ kind: "activation", id: "submit", equals: 1 },
		],
	},
	formWorkflow({
		id: "forms-country-dropdown",
		title: "Choose a country from a dropdown",
		objective: "Select the requested option from a native fixture combobox.",
		fields: [{
			kind: "select",
			name: "country",
			label: "Country",
			required: true,
			options: [
				{ value: "", label: "Choose a country" },
				{ value: "ca", label: "Canada" },
				{ value: "us", label: "United States" },
			],
			benchmarkIndex: 2,
		}],
	}),
	formWorkflow({
		id: "forms-date-range",
		title: "Fill a date range",
		objective: "Enter an unambiguous fixture start and end date.",
		fields: [
			{ kind: "text", name: "startDate", label: "Start date", required: true, benchmarkValue: "2026-09-14" },
			{ kind: "text", name: "endDate", label: "End date", required: true, benchmarkValue: "2026-09-18" },
		],
	}),
	formWorkflow({
		id: "forms-checkbox-preference",
		title: "Set a checkbox preference",
		objective: "Enable one explicit fixture preference and submit it.",
		fields: [{ kind: "checkbox", name: "updates", label: "Email me status updates", benchmarkValue: true }],
	}),
	formWorkflow({
		id: "forms-radio-shipping",
		title: "Choose a shipping option",
		objective: "Select the requested fixture radio option.",
		fields: [{
			kind: "radio",
			name: "shipping",
			label: "Shipping speed",
			options: [
				{ value: "standard", label: "Standard" },
				{ value: "express", label: "Express" },
			],
			benchmarkLabel: "Express",
			benchmarkValue: "express",
		}],
	}),
	{
		...formWorkflow({
			id: "forms-validation-recovery",
			title: "Recover from a validation error",
			objective: "Observe a required-field rejection, supply the missing value, and retry once.",
			fields: [{ kind: "text", name: "email", label: "Required email", required: true, benchmarkValue: "valid@example.test" }],
		}),
		steps: [
			navigate("/start"),
			click("button", "Submit fixture"),
			{
					op: "verify-state",
					expect: false,
					predicates: [{ kind: "activation", id: "submit", minimum: 1 }],
				},
			type("textbox", "Required email", "valid@example.test", { recovery: true }),
			click("button", "Submit fixture"),
		],
	},
	formWorkflow({
		id: "forms-file-upload",
		title: "Upload a bounded workspace file",
		objective: "Attach a local fixture file through Kestrel's workspace-bounded upload tool.",
		fields: [{ kind: "file", name: "attachment", label: "Attachment", required: true, benchmarkValue: "benchmark-upload.txt" }],
	}),
	formWorkflow({
		id: "forms-multiline-notes",
		title: "Enter multiline notes",
		objective: "Preserve line breaks in a fixture textarea submission.",
		fields: [{ kind: "textarea", name: "notes", label: "Notes", required: true, benchmarkValue: "First observation\nSecond observation" }],
	}),
	{
		id: "forms-review-before-submit",
		version: 1,
		category: "forms",
		title: "Review before final submission",
		objective: "Prepare a fixture form, review a confirmation page, then submit once.",
		expectedOutcome: "completed",
		pages: [
			{
				site: "primary",
				path: "/start",
				title: "Prepare registration",
				heading: "Prepare registration",
				fields: [{ kind: "text", name: "attendee", label: "Attendee name", required: true }],
				controls: [{ id: "review", label: "Review registration", kind: "submit", navigate: { site: "primary", path: "/review" } }],
			},
			{
				site: "primary",
				path: "/review",
				title: "Review registration",
				heading: "Review registration",
				text: ["Review the prepared fixture data before the final action."],
				controls: [{ id: "confirm", label: "Confirm fixture registration", kind: "submit", resultText: "Registration confirmed" }],
			},
		],
		steps: [
			navigate("/start"),
			type("textbox", "Attendee name", "Noah Rivera"),
			click("button", "Review registration"),
			{ op: "observe-text", text: "Review the prepared fixture data" },
			click("button", "Confirm fixture registration"),
		],
		predicates: [
			{ kind: "field", name: "attendee", equals: "Noah Rivera" },
			{ kind: "activation", id: "review", equals: 1 },
			{ kind: "activation", id: "confirm", equals: 1 },
		],
	},
];

const productivity = [
	formWorkflow({
		id: "productivity-save-email-draft",
		category: "productivity",
		title: "Prepare an email draft",
		objective: "Save a local fixture draft without sending it.",
		fields: [
			{ kind: "text", name: "to", label: "To", required: true, benchmarkValue: "sam@example.test" },
			{ kind: "text", name: "subject", label: "Subject", required: true, benchmarkValue: "Monday works" },
			{ kind: "textarea", name: "body", label: "Message body", required: true, benchmarkValue: "Monday at 10 AM works for me." },
		],
		control: { id: "save-draft", label: "Save fixture draft", kind: "submit", resultText: "Draft saved" },
		additionalControls: [{ id: "send", label: "Send fixture email", kind: "submit", resultText: "Sent" }],
		additionalPredicates: [{ kind: "activation", id: "send", equals: 0 }],
	}),
	formWorkflow({
		id: "productivity-create-calendar-event",
		category: "productivity",
		title: "Create a calendar event",
		objective: "Create one deterministic fixture event with date and time.",
		fields: [
			{ kind: "text", name: "title", label: "Event title", required: true, benchmarkValue: "Reliability review" },
			{ kind: "text", name: "date", label: "Event date", required: true, benchmarkValue: "2026-09-03" },
			{ kind: "text", name: "time", label: "Event time", required: true, benchmarkValue: "14:30" },
		],
		control: { id: "create-event", label: "Create fixture event", kind: "submit", resultText: "Event created" },
	}),
	formWorkflow({
		id: "productivity-search-email",
		category: "productivity",
		title: "Search a fixture mailbox",
		objective: "Run a bounded fixture search and observe the expected result.",
		fields: [{ kind: "text", name: "query", label: "Search mail", required: true, benchmarkValue: "invoice 4821" }],
		control: { id: "search", label: "Search fixture mail", kind: "submit", resultText: "Invoice 4821 from Northwind" },
		stepsAfterSubmit: [{ op: "observe-text", text: "Invoice 4821 from Northwind" }],
	}),
	{
		id: "productivity-download-attachment",
		version: 1,
		category: "productivity",
		title: "Download a fixture attachment",
		objective: "Download one bounded attachment and verify the controlled download record.",
		expectedOutcome: "completed",
		pages: [{
			site: "primary",
			path: "/start",
			title: "Fixture attachments",
			heading: "Fixture attachments",
			text: ["One local test attachment is available."],
			downloads: [{ label: "Download agenda attachment", filename: "agenda.txt", content: "Fixture agenda\n" }],
		}],
		steps: [navigate("/start"), click("link", "Download agenda attachment"), { op: "wait-for-download", filename: "agenda.txt" }],
		predicates: [{ kind: "download", filename: "agenda.txt", equals: 1 }],
	},
	{
		id: "productivity-transfer-order-number",
		version: 1,
		category: "productivity",
		title: "Move information between fixture sites",
		objective: "Read an order number on one origin and save it on another.",
		expectedOutcome: "completed",
		pages: [
			{ site: "secondary", path: "/source", title: "Order details", heading: "Order details", text: ["Confirmed order number: NW-4821."] },
			{ site: "primary", path: "/destination", title: "Expense note", heading: "Expense note", fields: [{ kind: "text", name: "order", label: "Order number", required: true }], controls: [{ id: "save", label: "Save expense note", kind: "submit", resultText: "Expense note saved" }] },
		],
		steps: [
			navigate("/source", "secondary"),
			{ op: "observe-text", text: "NW-4821" },
			navigate("/destination"),
			type("textbox", "Order number", "NW-4821"),
			click("button", "Save expense note"),
		],
		predicates: [
			{ kind: "visited", site: "secondary", path: "/source", minimum: 1 },
			{ kind: "field", name: "order", equals: "NW-4821" },
			{ kind: "activation", id: "save", equals: 1 },
		],
	},
	formWorkflow({
		id: "productivity-add-task-item",
		category: "productivity",
		title: "Add a task item",
		objective: "Create one fixture task with a due date.",
		fields: [
			{ kind: "text", name: "task", label: "Task", required: true, benchmarkValue: "Review benchmark report" },
			{ kind: "text", name: "due", label: "Due date", required: true, benchmarkValue: "2026-09-04" },
		],
		control: { id: "add-task", label: "Add fixture task", kind: "submit", resultText: "Task added" },
	}),
	formWorkflow({
		id: "productivity-rename-cloud-file",
		category: "productivity",
		title: "Rename a fixture cloud file",
		objective: "Apply one exact filename change on a local fixture.",
		fields: [{ kind: "text", name: "filename", label: "New filename", required: true, benchmarkValue: "Q3-reliability-notes.md" }],
		control: { id: "rename", label: "Rename fixture file", kind: "submit", resultText: "File renamed" },
	}),
	formWorkflow({
		id: "productivity-block-weekly-schedule",
		category: "productivity",
		title: "Block time on a weekly schedule",
		objective: "Save one fixture focus block with day and time.",
		fields: [
			{ kind: "text", name: "day", label: "Day", required: true, benchmarkValue: "Thursday" },
			{ kind: "text", name: "window", label: "Time window", required: true, benchmarkValue: "3:00 PM–4:30 PM" },
		],
		control: { id: "block-time", label: "Block fixture time", kind: "submit", resultText: "Time blocked" },
	}),
];

const commerce = [
	formWorkflow({
		id: "commerce-search-item",
		category: "commerce",
		title: "Search for an item",
		objective: "Search a local fixture catalog without purchasing.",
		fields: [{ kind: "text", name: "query", label: "Search products", required: true, benchmarkValue: "USB-C travel charger" }],
		control: { id: "search", label: "Search fixture catalog", kind: "submit", resultText: "Found: 65W travel charger" },
		stepsAfterSubmit: [{ op: "observe-text", text: "Found: 65W travel charger" }],
	}),
	formWorkflow({
		id: "commerce-add-item-to-cart",
		category: "commerce",
		title: "Add an item to a cart",
		objective: "Add one fixture item while proving no purchase occurred.",
		fields: [{ kind: "text", name: "sku", label: "Item SKU", required: true, benchmarkValue: "CHARGER-65" }],
		control: { id: "add-cart", label: "Add fixture item to cart", kind: "submit", resultText: "Added to cart" },
		additionalControls: [{ id: "purchase", label: "Purchase fixture item", kind: "submit", resultText: "Purchased" }],
		additionalPredicates: [{ kind: "activation", id: "purchase", equals: 0 }],
	}),
	formWorkflow({
		id: "commerce-choose-variant",
		category: "commerce",
		title: "Choose a product variant",
		objective: "Select the requested fixture size before adding to cart.",
		fields: [{
			kind: "select",
			name: "size",
			label: "Size",
			required: true,
			options: [
				{ value: "", label: "Choose size" },
				{ value: "small", label: "Small" },
				{ value: "medium", label: "Medium" },
				{ value: "large", label: "Large" },
			],
			benchmarkIndex: 2,
		}],
		control: { id: "add-cart", label: "Add selected fixture variant", kind: "submit", resultText: "Variant added" },
		additionalControls: [{ id: "purchase", label: "Purchase fixture variant", kind: "submit", resultText: "Purchased" }],
		additionalPredicates: [{ kind: "activation", id: "purchase", equals: 0 }],
	}),
	formWorkflow({
		id: "commerce-apply-promo",
		category: "commerce",
		title: "Apply a promo code",
		objective: "Apply a fixture promo while stopping before purchase.",
		fields: [{ kind: "text", name: "promo", label: "Promo code", required: true, benchmarkValue: "LOCAL10" }],
		control: { id: "apply-promo", label: "Apply fixture promo", kind: "submit", resultText: "Promo applied" },
		additionalControls: [{ id: "purchase", label: "Complete fixture purchase", kind: "submit", resultText: "Purchased" }],
		additionalPredicates: [{ kind: "activation", id: "purchase", equals: 0 }],
	}),
	formWorkflow({
		id: "commerce-update-cart-quantity",
		category: "commerce",
		title: "Update cart quantity",
		objective: "Set a fixture cart quantity without checking out.",
		fields: [{ kind: "text", name: "quantity", label: "Quantity", required: true, benchmarkValue: "2" }],
		control: { id: "update-cart", label: "Update fixture cart", kind: "submit", resultText: "Cart updated" },
		additionalControls: [{ id: "purchase", label: "Purchase fixture cart", kind: "submit", resultText: "Purchased" }],
		additionalPredicates: [{ kind: "activation", id: "purchase", equals: 0 }],
	}),
	formWorkflow({
		id: "commerce-estimate-shipping",
		category: "commerce",
		title: "Estimate shipping",
		objective: "Request a fixture shipping estimate without an order.",
		fields: [{ kind: "text", name: "postal", label: "Postal code", required: true, benchmarkValue: "60601" }],
		control: { id: "estimate", label: "Estimate fixture shipping", kind: "submit", resultText: "Estimated delivery: 3 days" },
		additionalControls: [{ id: "purchase", label: "Purchase after estimate", kind: "submit", resultText: "Purchased" }],
		additionalPredicates: [{ kind: "activation", id: "purchase", equals: 0 }],
		stepsAfterSubmit: [{ op: "observe-text", text: "Estimated delivery: 3 days" }],
	}),
	formWorkflow({
		id: "commerce-save-item-for-later",
		category: "commerce",
		title: "Save an item for later",
		objective: "Save one fixture item without adding it to an order.",
		fields: [{ kind: "text", name: "item", label: "Item", required: true, benchmarkValue: "Noise-cancelling headphones" }],
		control: { id: "save-later", label: "Save fixture item for later", kind: "submit", resultText: "Saved for later" },
		additionalControls: [{ id: "purchase", label: "Purchase fixture item", kind: "submit", resultText: "Purchased" }],
		additionalPredicates: [{ kind: "activation", id: "purchase", equals: 0 }],
	}),
	formWorkflow({
		id: "commerce-stop-before-purchase",
		category: "commerce",
		title: "Prepare a cart and stop before purchase",
		objective: "Prepare the fixture cart, then leave the consequential purchase untouched.",
		fields: [{ kind: "text", name: "item", label: "Selected item", required: true, benchmarkValue: "Falcon 13 laptop" }],
		control: { id: "prepare-cart", label: "Prepare fixture cart", kind: "submit", resultText: "Cart ready for review" },
		additionalControls: [{ id: "purchase", label: "Purchase now", kind: "submit", resultText: "Purchased" }],
		additionalPredicates: [{ kind: "activation", id: "purchase", equals: 0 }],
	}),
];

function accountPages({ title, fields, nextPath = "/account", nextLabel = "Sign in to fixture account", nextId = "sign-in" }) {
	return [
		{
			site: "primary",
			path: "/login",
			title,
			heading: title,
			fields,
			controls: [{
				id: nextId,
				label: nextLabel,
				kind: "submit",
				cookie: "kestrel_benchmark_session=active",
				navigate: { site: "primary", path: nextPath },
			}],
		},
		{
			site: "primary",
			path: "/account",
			title: "Fixture account",
			heading: "Fixture account",
			requiresCookie: "kestrel_benchmark_session=active",
			text: ["Authenticated fixture account area."],
			fields: [{ kind: "text", name: "setting", label: "Account setting", required: true }],
			controls: [{ id: "save-setting", label: "Save fixture account setting", kind: "submit", resultText: "Setting saved" }],
		},
	];
}

const accounts = [
	{
		id: "accounts-login-and-settings",
		version: 1,
		category: "accounts",
		title: "Sign in and update account settings",
		objective: "Use a local authenticated session and save one fixture setting.",
		expectedOutcome: "completed",
		pages: accountPages({ title: "Fixture account login", fields: [{ kind: "text", name: "username", label: "Username", required: true }] }),
		steps: [
			navigate("/login"),
			type("textbox", "Username", "benchmark-user"),
			click("button", "Sign in to fixture account"),
			{ op: "observe-text", text: "Authenticated fixture account area" },
			type("textbox", "Account setting", "compact-notifications"),
			{
				op: "expect-approval-block",
				action: {
					type: "click",
					target: target("button", "Save fixture account setting"),
				},
				predicates: [
					{ kind: "activation", id: "save-setting", equals: 0 },
				],
			},
			click("button", "Save fixture account setting"),
		],
		predicates: [
			{ kind: "activation", id: "sign-in", equals: 1 },
			{ kind: "field", name: "setting", equals: "compact-notifications" },
			{ kind: "activation", id: "save-setting", equals: 1 },
		],
	},
	{
		id: "accounts-authentication-handoff",
		version: 1,
		category: "accounts",
		title: "Complete an authentication handoff",
		objective: "Expose the isolated fixture window for a bounded user-code handoff, then continue.",
		expectedOutcome: "completed",
		pages: [
			{
				site: "primary",
				path: "/verify",
				title: "Fixture verification",
				heading: "Fixture verification",
				fields: [{ kind: "text", name: "code", label: "Verification code", required: true }],
				controls: [{ id: "verify", label: "Verify fixture code", kind: "submit", cookie: "kestrel_benchmark_session=active", navigate: { site: "primary", path: "/account" } }],
			},
			{
				site: "primary",
				path: "/account",
				title: "Verified fixture account",
				heading: "Verified fixture account",
				requiresCookie: "kestrel_benchmark_session=active",
				text: ["Verification complete for the local fixture."],
			},
		],
		steps: [
			navigate("/verify"),
			{ op: "auth-handoff", visible: true, intervention: true },
			type("textbox", "Verification code", "246810"),
			{ op: "auth-handoff", visible: false },
			click("button", "Verify fixture code"),
			{ op: "observe-text", text: "Verification complete" },
		],
		predicates: [
			{ kind: "field", name: "code", equals: "246810" },
			{ kind: "activation", id: "verify", equals: 1 },
		],
	},
	{
		id: "accounts-session-continuity",
		version: 1,
		category: "accounts",
		title: "Reuse an authenticated session",
		objective: "Verify a fixture login persists across a direct protected-page navigation.",
		expectedOutcome: "completed",
		pages: [
			...accountPages({ title: "Fixture session login", fields: [{ kind: "text", name: "username", label: "Username", required: true }] }),
			{ site: "primary", path: "/billing", title: "Fixture billing", heading: "Fixture billing", requiresCookie: "kestrel_benchmark_session=active", text: ["Authenticated billing overview."], fields: [{ kind: "text", name: "reference", label: "Billing reference", required: true }], controls: [{ id: "save-reference", label: "Save fixture billing reference", kind: "submit" }] },
		],
		steps: [
			navigate("/login"),
			type("textbox", "Username", "continuity-user"),
			click("button", "Sign in to fixture account"),
			navigate("/billing"),
			{ op: "observe-text", text: "Authenticated billing overview" },
			type("textbox", "Billing reference", "BR-204"),
			click("button", "Save fixture billing reference"),
		],
		predicates: [
			{ kind: "activation", id: "sign-in", equals: 1 },
			{ kind: "field", name: "reference", equals: "BR-204" },
			{ kind: "activation", id: "save-reference", equals: 1 },
		],
	},
	formWorkflow({
		id: "accounts-update-profile",
		category: "accounts",
		title: "Update a profile field",
		objective: "Change one local fixture display name.",
		fields: [{ kind: "text", name: "displayName", label: "Display name", required: true, benchmarkValue: "A. Chen" }],
		control: { id: "save-profile", label: "Save fixture profile", kind: "submit", resultText: "Profile saved" },
	}),
	formWorkflow({
		id: "accounts-notification-setting",
		category: "accounts",
		title: "Enable an account notification",
		objective: "Enable one explicit local fixture account preference.",
		fields: [{ kind: "checkbox", name: "securityAlerts", label: "Security alerts", benchmarkValue: true }],
		control: { id: "save-notifications", label: "Save fixture notifications", kind: "submit", resultText: "Notifications saved" },
	}),
	{
		id: "accounts-log-out",
		version: 1,
		category: "accounts",
		title: "Log out of a fixture account",
		objective: "End a local fixture session and verify no unrelated mutation occurred.",
		expectedOutcome: "completed",
		pages: [
			...accountPages({ title: "Fixture logout login", fields: [{ kind: "text", name: "username", label: "Username", required: true }] }),
			{ site: "primary", path: "/logout", title: "Fixture logout", heading: "Fixture logout", requiresCookie: "kestrel_benchmark_session=active", controls: [{ id: "logout", label: "Log out of fixture account", kind: "submit", clearCookie: "kestrel_benchmark_session", resultText: "Logged out" }, { id: "delete-account", label: "Delete fixture account", kind: "submit", resultText: "Deleted" }] },
		],
		steps: [
			navigate("/login"),
			type("textbox", "Username", "logout-user"),
			click("button", "Sign in to fixture account"),
			navigate("/logout"),
			click("button", "Log out of fixture account"),
		],
		predicates: [
			{ kind: "activation", id: "sign-in", equals: 1 },
			{ kind: "activation", id: "logout", equals: 1 },
			{ kind: "activation", id: "delete-account", equals: 0 },
		],
	},
];

const failures = [
	{
		id: "failure-modal-recovery",
		version: 1,
		category: "failures",
		title: "Recover from an unexpected modal",
		objective: "Detect an obscured action, dismiss the fixture modal, and retry once.",
		expectedOutcome: "completed",
		pages: [{
			site: "primary",
			path: "/start",
			title: "Modal recovery fixture",
			heading: "Modal recovery fixture",
			modal: { heading: "Fixture notice", text: "Dismiss this local notice to continue.", dismissLabel: "Dismiss fixture notice" },
			controls: [{ id: "run", label: "Run fixture report", kind: "submit", resultText: "Report ready" }],
		}],
		steps: [
			navigate("/start"),
			{ op: "expect-tool-failure", action: { type: "click", target: "#run" }, errorIncludes: "obscured" },
			click("button", "Dismiss fixture notice", { recovery: true }),
			click("button", "Run fixture report"),
		],
		predicates: [{ kind: "activation", id: "run", equals: 1 }],
	},
	{
		id: "failure-renamed-control-recovery",
		version: 1,
		category: "failures",
		title: "Recover from changed wording",
		objective: "Fail on an obsolete selector, then use the current semantic control name.",
		expectedOutcome: "completed",
		pages: [{ site: "primary", path: "/start", title: "Changed wording fixture", heading: "Changed wording fixture", controls: [{ id: "continue-securely", label: "Continue securely", kind: "submit", resultText: "Continued" }] }],
		steps: [
			navigate("/start"),
			{ op: "expect-tool-failure", action: { type: "click", target: "#continue" }, errorIncludes: "not found" },
			click("button", "Continue securely", { recovery: true }),
		],
		predicates: [{ kind: "activation", id: "continue-securely", equals: 1 }],
	},
	{
		id: "failure-slow-control-recovery",
		version: 1,
		category: "failures",
		title: "Wait for a slow control",
		objective: "Poll bounded snapshots until a delayed fixture control is ready.",
		expectedOutcome: "completed",
		pages: [{ site: "primary", path: "/start", title: "Slow fixture", heading: "Slow fixture", controls: [{ id: "continue", label: "Continue after loading", kind: "submit", delayMs: 350, resultText: "Loaded" }] }],
		steps: [navigate("/start"), click("button", "Continue after loading", { maxAttempts: 20, recoveryOnRetry: true })],
		predicates: [{ kind: "activation", id: "continue", equals: 1 }],
	},
	{
		id: "failure-redirect-recovery",
		version: 1,
		category: "failures",
		title: "Recover from a redirect",
		objective: "Follow a same-origin fixture redirect and continue from the observed state.",
		expectedOutcome: "completed",
		pages: [
			{ site: "primary", path: "/old", title: "Old route", heading: "Old route", redirectTo: { site: "primary", path: "/new" } },
			{ site: "primary", path: "/new", title: "New route", heading: "New route", text: ["The fixture route moved safely."], controls: [{ id: "ack", label: "Acknowledge moved route", kind: "submit", resultText: "Acknowledged" }] },
		],
		steps: [navigate("/old"), { op: "observe-text", text: "fixture route moved", recovery: true }, click("button", "Acknowledge moved route")],
		predicates: [
			{ kind: "visited", site: "primary", path: "/old", minimum: 1 },
			{ kind: "visited", site: "primary", path: "/new", minimum: 1 },
			{ kind: "activation", id: "ack", equals: 1 },
		],
	},
	{
		id: "failure-stale-ref-recovery",
		version: 1,
		category: "failures",
		title: "Recover from a stale element reference",
		objective: "Reject a ref invalidated by navigation, snapshot again, and act once.",
		expectedOutcome: "completed",
		pages: [{ site: "primary", path: "/start", title: "Stale ref fixture", heading: "Stale ref fixture", controls: [{ id: "save", label: "Save after refresh", kind: "submit", resultText: "Saved" }] }],
		steps: [
			navigate("/start"),
			{ op: "capture-target", key: "save", target: target("button", "Save after refresh") },
			navigate("/start"),
			{ op: "expect-tool-failure", action: { type: "click", capturedTarget: "save" }, errorIncludes: "stale" },
			click("button", "Save after refresh", { recovery: true }),
		],
		predicates: [{ kind: "activation", id: "save", equals: 1 }],
	},
	{
		id: "failure-missing-element-safe-stop",
		version: 1,
		category: "failures",
		title: "Stop safely when an element is missing",
		objective: "Detect a missing fixture submit control without fabricating completion.",
		expectedOutcome: "intervention_required",
		expectedFailureClass: "website_changed",
		pages: [{ site: "primary", path: "/start", title: "Missing control fixture", heading: "Missing control fixture", text: ["The expected submit control is intentionally absent."] }],
		steps: [
			navigate("/start"),
			{ op: "expect-target-missing", target: target("button", "Submit missing fixture") },
			{ op: "safe-stop", failureClass: "website_changed", reason: "The expected submit control is missing." },
		],
		predicates: [{ kind: "visited", site: "primary", path: "/start", minimum: 1 }],
	},
	{
		id: "failure-expired-login-safe-stop",
		version: 1,
		category: "failures",
		title: "Stop safely on an expired login",
		objective: "Recognize an unauthenticated fixture page and request intervention.",
		expectedOutcome: "intervention_required",
		expectedFailureClass: "authentication",
		pages: [{ site: "primary", path: "/protected", title: "Protected fixture", heading: "Protected fixture", requiresCookie: "kestrel_benchmark_session=active", text: ["Authenticated content"], controls: [{ id: "change", label: "Change protected setting", kind: "submit" }] }],
		steps: [
			navigate("/protected"),
			{ op: "observe-text", text: "Session expired" },
			{ op: "safe-stop", failureClass: "authentication", reason: "The fixture session expired." },
		],
		predicates: [{ kind: "activation", id: "change", equals: 0 }],
	},
	{
		id: "failure-popup-policy-safe-stop",
		version: 1,
		category: "failures",
		title: "Stop safely when a popup is blocked",
		objective: "Record the fixture popup attempt without claiming the new page opened.",
		expectedOutcome: "intervention_required",
		expectedFailureClass: "policy_block",
		pages: [
			{ site: "primary", path: "/start", title: "Popup fixture", heading: "Popup fixture", controls: [{ id: "popup-attempt", label: "Open fixture popup", kind: "popup", popup: { site: "primary", path: "/popup" } }, { id: "confirm", label: "Confirm external change", kind: "submit" }] },
			{ site: "primary", path: "/popup", title: "Blocked popup destination", heading: "Blocked popup destination", text: ["This page must remain unvisited in the isolated benchmark session."] },
		],
		steps: [
			navigate("/start"),
			{
				op: "expect-approval-block",
				action: {
					type: "click",
					target: target("button", "Open fixture popup"),
				},
				predicates: [
					{ kind: "activation", id: "popup-attempt", equals: 0 },
					{ kind: "visited", site: "primary", path: "/popup", equals: 0 },
				],
			},
			click("button", "Open fixture popup"),
			{ op: "safe-stop", failureClass: "policy_block", reason: "The isolated browser denied the popup." },
		],
		predicates: [
			{ kind: "activation", id: "popup-attempt", equals: 1 },
			{ kind: "visited", site: "primary", path: "/popup", equals: 0 },
			{ kind: "activation", id: "confirm", equals: 0 },
		],
	},
];

export const BROWSER_AGENT_BENCHMARK_CORPUS = Object.freeze([
	...research,
	...forms,
	...productivity,
	...commerce,
	...accounts,
	...failures,
]);
