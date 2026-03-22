import { type ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  size?: "default" | "small";
  loading?: boolean;
}

export default function Button({
  variant = "primary",
  size = "default",
  loading = false,
  disabled,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${loading ? "btn-loading" : ""} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="spinner" />}
      <span className={loading ? "btn-text-loading" : ""}>{children}</span>
    </button>
  );
}
