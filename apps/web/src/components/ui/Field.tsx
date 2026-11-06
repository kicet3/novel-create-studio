import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "../../lib/cx.js";
import { CONTROL_FOCUS, CONTROL_SHAPE, CONTROL_SIZE, type ControlSize } from "./control.js";

/** border / colours / states shared by Input, Select and Textarea */
const CONTROL =
  "block min-w-0 border border-border bg-surface text-text placeholder:text-faint " +
  "aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-60 " +
  `${CONTROL_SHAPE} ${CONTROL_FOCUS}`;

/** `w-full` unless the call site sets its own width (`w-auto`, `w-28`, …): cx() does not merge classes, and
 * `w-full` would win over `w-auto` in the generated CSS order */
const width = (className?: string) => (/(^|\s)w-\S+/.test(className ?? "") ? undefined : "w-full");

/** file inputs: the picker button fills the control height on the left */
const FILE =
  "cursor-pointer pl-0 file:mr-3 file:h-full file:cursor-pointer file:border-0 file:border-r file:border-solid file:border-border " +
  "file:bg-surface-2 file:px-3 file:text-[12.5px] file:font-semibold file:text-text hover:file:bg-border";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** md = 36px (default, forms), sm = 32px (toolbars, table cells, filters) */
  controlSize?: ControlSize;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, controlSize = "md", type, ...rest }, ref) {
  return <input ref={ref} type={type} className={cx(CONTROL, width(className), CONTROL_SIZE[controlSize], type === "file" && FILE, className)} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  controlSize?: ControlSize;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 4, controlSize = "md", ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx(CONTROL, width(className), "resize-y leading-relaxed", controlSize === "md" ? "px-3 py-2 text-[13px]" : "px-2.5 py-1.5 text-[12.5px]", className)}
      {...rest}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: ControlSize;
}

/** native <select> without platform chrome: same box as Input + a themed chevron (`--select-chevron`, theme.css) */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, controlSize = "md", ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cx(
        CONTROL,
        width(className),
        CONTROL_SIZE[controlSize],
        "cursor-pointer appearance-none truncate bg-(image:--select-chevron) bg-size-[12px_12px] bg-position-[right_10px_center] bg-no-repeat pr-8",
        className,
      )}
      {...rest}
    />
  );
});

export interface FieldProps {
  label: ReactNode;
  /** A single Input / Select / Textarea; `id`, `aria-describedby`, `aria-invalid` are wired automatically. */
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Button(s) on the control's row (e.g. 저장): stays aligned with the control, hint/error go below both. */
  action?: ReactNode;
  className?: string;
}

/** `.field`: label + control + hint/error, accessibly linked. */
export function Field({ label, children, hint, error, required, action, className }: FieldProps) {
  const autoId = useId();
  const id = children.props.id ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [children.props["aria-describedby"], hintId, errId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })
    : children;
  return (
    <div className={cx("flex min-w-0 flex-col gap-1 text-[12.5px]", className)}>
      <label htmlFor={id} className="font-semibold text-muted">
        {label}
        {required && (
          <span className="text-danger" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {action ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 [&>:first-child]:min-w-40 [&>:first-child]:flex-1">
          {control}
          {action}
        </div>
      ) : (
        control
      )}
      {hint && (
        <div id={hintId} className="text-xs text-faint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errId} className="text-xs text-danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
