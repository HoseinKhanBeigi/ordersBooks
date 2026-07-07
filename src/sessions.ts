export type SessionId = "tokyo" | "london" | "newyork";

export interface TradingSession {
  id: SessionId;
  label: string;
  timezone: string;
  /** Inclusive open hour in session local time (24h). */
  openHour: number;
  openMinute: number;
  /** Exclusive close hour in session local time (24h). */
  closeHour: number;
  closeMinute: number;
}

export interface SessionStatus {
  id: SessionId;
  label: string;
  timezone: string;
  isOpen: boolean;
  localTime: string;
  hoursLabel: string;
}

const SESSIONS: TradingSession[] = [
  {
    id: "tokyo",
    label: "Tokyo",
    timezone: "Asia/Tokyo",
    openHour: 9,
    openMinute: 0,
    closeHour: 18,
    closeMinute: 0,
  },
  {
    id: "london",
    label: "London",
    timezone: "Europe/London",
    openHour: 8,
    openMinute: 0,
    closeHour: 17,
    closeMinute: 0,
  },
  {
    id: "newyork",
    label: "New York",
    timezone: "America/New_York",
    openHour: 9,
    openMinute: 30,
    closeHour: 16,
    closeMinute: 0,
  },
];

function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function formatLocalTime(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatHoursLabel(session: TradingSession): string {
  const open = `${pad(session.openHour)}:${pad(session.openMinute)}`;
  const close = `${pad(session.closeHour)}:${pad(session.closeMinute)}`;
  return `${open}–${close} local`;
}

export function isSessionOpen(now: Date, session: TradingSession): boolean {
  const mins = localMinutes(now, session.timezone);
  const open = session.openHour * 60 + session.openMinute;
  const close = session.closeHour * 60 + session.closeMinute;
  return mins >= open && mins < close;
}

export function getSessionStatuses(now = new Date()): SessionStatus[] {
  return SESSIONS.map((session) => ({
    id: session.id,
    label: session.label,
    timezone: session.timezone,
    isOpen: isSessionOpen(now, session),
    localTime: formatLocalTime(now, session.timezone),
    hoursLabel: formatHoursLabel(session),
  }));
}

export function getActiveSessionLabels(now = new Date()): string[] {
  return getSessionStatuses(now)
    .filter((session) => session.isOpen)
    .map((session) => session.label);
}

export function formatUtcClock(now = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}
