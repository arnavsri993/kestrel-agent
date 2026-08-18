import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";

export type ButtonVariant =
  "primary" | "secondary" | "ghost" | "destructive" | "icon";

export function Button({
  variant = "secondary",
  busy = false,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`ui-button ui-button-${variant} ${className}`.trim()}
      aria-busy={busy || undefined}
      disabled={busy || props.disabled}
    >
      {busy ? <span className="ui-spinner" aria-hidden="true" /> : children}
    </button>
  );
}

export function Card({
  interactive = false,
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  interactive?: boolean;
}) {
  return (
    <section
      {...props}
      className={`ui-card ${interactive ? "ui-card-interactive" : ""} ${className}`.trim()}
    >
      {children}
    </section>
  );
}

export function Row({
  icon,
  title,
  detail,
  trailing,
  className = "",
  ...props
}: HTMLAttributes<HTMLElement> & {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div {...props} className={`ui-row ${className}`.trim()}>
      <span className="ui-row-icon" aria-hidden={icon ? true : undefined}>
        {icon}
      </span>
      <span className="ui-row-copy">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {trailing && <span className="ui-row-trailing">{trailing}</span>}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props} className={`ui-input ${props.className ?? ""}`.trim()} />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`ui-textarea ${props.className ?? ""}`.trim()}
    />
  );
}

export type StatusTone =
  | "needs-approval"
  | "running"
  | "verified"
  | "error"
  | "warning"
  | "info"
  | "neutral";

const statusIcons: Record<StatusTone, string> = {
  "needs-approval": "warning",
  running: "agent",
  verified: "check-circle",
  error: "alert-circle",
  warning: "warning",
  info: "info",
  neutral: "info",
};

export function Status({
  tone,
  children,
  className = "",
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`ui-status ui-status-${tone} ${className}`.trim()}>
      <Icon name={statusIcons[tone]} />
      <span>{children}</span>
    </span>
  );
}

export function EmptyState({
  title,
  detail,
  action,
  className = "",
}: {
  title: string;
  detail: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ui-empty-state ${className}`.trim()}>
      <span className="ui-empty-state-mark" aria-hidden="true">
        <BrandMark />
      </span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {action && <div className="ui-empty-state-action">{action}</div>}
    </section>
  );
}
