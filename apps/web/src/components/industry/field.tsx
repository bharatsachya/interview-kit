import type { ComponentPropsWithRef, ReactNode } from "react";
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

/* Borderless: the fill is what says "you can type here". A 1px box inside a card that has no
   border of its own is the seam the softened system exists to remove. */
const CONTROL =
  "bg-tint-soft rounded-control w-full min-h-11 px-3 py-2 text-base transition-colors hover:bg-tint";

export function TextInput({
  label,
  hint,
  error,
  id,
  ...rest
}: ComponentPropsWithRef<"input"> & { label: string; hint?: string; error?: string }) {
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
}: ComponentPropsWithRef<"textarea"> & { label: string; hint?: string; error?: string }) {
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
