import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { useId } from "react";

/**
 * Label, hint and error wired to the control by id, so the error is announced rather than
 * merely drawn. The error is the one red used as text; everything else about the field stays
 * on the ink palette.
 */
export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-xs opacity-70">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-xs opacity-55">{hint}</p> : null}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-alarm text-xs font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "bg-paper border-divider rounded-control w-full min-h-11 border px-3 py-2 text-base hover:border-ink/45 focus-visible:border-teal-700";

export function TextInput({
  label,
  hint,
  error,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        className={CONTROL}
      />
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  error,
  id,
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: string }) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <textarea
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        className={`${CONTROL} resize-y leading-relaxed ${className}`}
      />
    </Field>
  );
}
