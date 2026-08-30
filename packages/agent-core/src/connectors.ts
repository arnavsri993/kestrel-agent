export interface EmailConnector {
	sendDraft(input: {
		operationId: string;
		to: string;
		subject: string;
		body: string;
	}): { messageId: string };
	verifySent(messageId: string): boolean;
}

export interface CalendarConnector {
	createEvent(input: {
		operationId: string;
		title: string;
		startsAt: string;
		durationMinutes: number;
	}): { eventId: string };
	verifyEvent(eventId: string): boolean;
}

/** Production-safe default: external actions require an explicitly configured connector. */
export class UnavailableEmailConnector implements EmailConnector {
	sendDraft(_input: Parameters<EmailConnector["sendDraft"]>[0]): never {
		throw new Error("Email connector is not configured.");
	}
	verifySent(_messageId: string): boolean {
		return false;
	}
}

/** Production-safe default: external actions require an explicitly configured connector. */
export class UnavailableCalendarConnector implements CalendarConnector {
	createEvent(_input: Parameters<CalendarConnector["createEvent"]>[0]): never {
		throw new Error("Calendar connector is not configured.");
	}
	verifyEvent(_eventId: string): boolean {
		return false;
	}
}

export class DevelopmentEmailConnector implements EmailConnector {
	readonly sent = new Map<
		string,
		{ messageId: string; to: string; subject: string; body: string }
	>();

	sendDraft(input: {
		operationId: string;
		to: string;
		subject: string;
		body: string;
	}): { messageId: string } {
		const existing = this.sent.get(input.operationId);
		if (existing) return { messageId: existing.messageId };
		const messageId = `mock-message-${this.sent.size + 1}`;
		this.sent.set(input.operationId, {
			messageId,
			to: input.to,
			subject: input.subject,
			body: input.body,
		});
		return { messageId };
	}

	verifySent(messageId: string): boolean {
		return [...this.sent.values()].some((item) => item.messageId === messageId);
	}
}

export class DevelopmentCalendarConnector implements CalendarConnector {
	readonly events = new Map<
		string,
		{
			eventId: string;
			title: string;
			startsAt: string;
			durationMinutes: number;
		}
	>();

	createEvent(input: {
		operationId: string;
		title: string;
		startsAt: string;
		durationMinutes: number;
	}): { eventId: string } {
		const existing = this.events.get(input.operationId);
		if (existing) return { eventId: existing.eventId };
		const eventId = `mock-event-${this.events.size + 1}`;
		this.events.set(input.operationId, {
			eventId,
			title: input.title,
			startsAt: input.startsAt,
			durationMinutes: input.durationMinutes,
		});
		return { eventId };
	}

	verifyEvent(eventId: string): boolean {
		return [...this.events.values()].some((item) => item.eventId === eventId);
	}
}
