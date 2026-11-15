import React, { useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

export function Card({
  title,
  children,
  className,
  extra,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className={cn("tv-card p-4", className)}>
      {(title || extra) && (
        <div className="flex justify-between items-center mb-4">
          {title && (
            <h3 className="text-sm font-semibold uppercase tracking-wider text-tv-text/50">{title}</h3>
          )}
          {extra}
        </div>
      )}
      {children}
    </div>
  );
}

export function TabButton({
  active,
  onClick,
  icon: Icon,
  color,
  label,
}: {
  active: boolean;
  onClick: () => void;
  /** An icon, or a color dot for user-defined tabs. */
  icon?: LucideIcon;
  color?: string;
  label: string;
}) {
  // On narrow screens the tab bar scrolls sideways: keep the active tab in view.
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 px-3 sm:px-4 py-3 border-b-2 shrink-0 transition-all whitespace-nowrap",
        active
          ? "border-tv-accent text-tv-accent bg-tv-accent/5"
          : "border-transparent text-tv-text/60 hover:text-tv-text hover:bg-white/5"
      )}
    >
      {Icon && <Icon size={18} className="hidden sm:block" />}
      {color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden="true" />}
      <span className="font-medium">{label}</span>
    </button>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-[10px] uppercase text-tv-text/40 font-bold">
      {children}
    </label>
  );
}

export function ErrorMessage({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="text-xs text-tv-down bg-tv-down/10 border border-tv-down/30 rounded p-2">
      {children}
    </div>
  );
}

/**
 * Password field with a "show password" toggle. The toggle sits beside the
 * input (not inside it) so it never overlaps password-manager autofill icons.
 */
export function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  placeholder,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password" | "off";
  minLength?: number;
  placeholder?: string;
  required?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-1">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <input
          id={id}
          type={visible ? "text" : "password"}
          className="tv-input flex-1 min-w-0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          minLength={minLength}
          placeholder={placeholder}
          required={required}
          spellCheck={false}
          autoCapitalize="none"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
          aria-pressed={visible}
          aria-controls={id}
          title={visible ? "Ocultar senha" : "Mostrar senha"}
          className="px-3 rounded border border-white/10 text-tv-text/60 hover:text-tv-text hover:bg-white/5 transition-all"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

export function FullScreenSpinner() {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-tv-bg text-tv-accent">
      <div className="h-12 w-12 rounded-full border-4 border-tv-accent/30 border-t-tv-accent animate-spin" />
    </div>
  );
}
