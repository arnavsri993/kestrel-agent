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
  | "solid"
  | "bordered"
  | "quiet"
  | "destructive"
  /** @deprecated Use `solid`. */
  | "primary"
  /** @deprecated Use `bordered`. */
  | "secondary"
  /** @deprecated Use `quiet`. */
  | "ghost"
  /** @deprecated Use an explicit quiet button with icon-only children. */
  | "icon";

export type ButtonSize = "compact" | "normal" | "decision";

const buttonVariantClass: Record<ButtonVariant, string> = {
  solid: "solid",
  bordered: "bordered",
  quiet: "quiet",
  destructive: "destructive",
  primary: "solid",
  secondary: "bordered",
  ghost: "quiet",
  icon: "icon",
};

export function Button({
  variant = "bordered",
  size = "normal",
  busy = false,
  type = "button",
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`ui-button ui-button-${buttonVariantClass[variant]} ui-button-${size} ${className}`.trim()}
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
      data-interactive={interactive || undefined}
    >
      {children}
    </section>
  );
}

export function Row({
  icon,
  title,
  detail,
  status,
  trailing,
  className = "",
  ...props
}: HTMLAttributes<HTMLElement> & {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div {...props} className={`ui-row ${className}`.trim()}>
      {icon ? (
        <span className="ui-row-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ui-row-copy">
        <strong>{title}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      {status ? <span className="ui-row-status">{status}</span> : null}
      {trailing ? <span className="ui-row-trailing">{trailing}</span> : null}
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
  "needs-approval": "alert-triangle-filled",
  running: "loader",
  verified: "check-circle-filled",
  error: "x-circle-filled",
  warning: "alert-triangle-filled",
  info: "info-filled",
  neutral: "info-filled",
};

export function Status({
  tone,
  children,
  className = "",
  live,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
  live?: "polite" | "assertive";
}) {
  return (
    <span
      className={`ui-status ui-status-${tone} ${className}`.trim()}
      {...(live ? { role: "status", "aria-live": live } : {})}
    >
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
  detail?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ui-empty-state ${className}`.trim()}>
      <span className="ui-empty-state-mark" aria-hidden="true">
        <BrandMark />
      </span>
      <h2>{title}</h2>
      {detail ? <p>{detail}</p> : null}
      {action ? <div className="ui-empty-state-action">{action}</div> : null}
    </section>
  );
}

export type PageMeasure = "reading" | "standard" | "wide" | "full";

type PageFrameProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  as?: "main" | "section" | "div";
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  navigation?: ReactNode;
  measure?: PageMeasure;
  titleId?: string;
};

/** Shared route scaffold for a page's one title, purpose, actions, and measure. */
export function PageFrame({
  as: Tag = "section",
  eyebrow,
  title,
  description,
  actions,
  navigation,
  measure = "standard",
  children,
  className = "",
  titleId,
  ...props
}: PageFrameProps) {
  return (
    <Tag
      {...props}
      className={`page-frame ui-page-frame ui-page-frame-${measure} ${className}`.trim()}
      {...(titleId ? { "aria-labelledby": titleId } : {})}
    >
      {eyebrow || title || description || actions ? (
        <header className="ui-page-frame-header">
          <div className="ui-page-frame-copy">
            {eyebrow ? (
              <p className="ui-page-frame-eyebrow">{eyebrow}</p>
            ) : null}
            {title ? (
              <h1 id={titleId} tabIndex={-1}>
                {title}
              </h1>
            ) : null}
            {description ? (
              <p className="ui-page-frame-description">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="ui-page-frame-actions">{actions}</div>
          ) : null}
        </header>
      ) : null}
      {navigation ? (
        <nav className="ui-page-frame-navigation">{navigation}</nav>
      ) : null}
      {children}
    </Tag>
  );
}
