import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

const variantClasses: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary/90 disabled:bg-stone-300",
  secondary: "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:text-stone-400",
  danger: "bg-danger-600 text-white hover:bg-danger-700 disabled:bg-stone-300",
  ghost: "text-stone-500 hover:text-primary disabled:text-stone-300",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      {...props}
      className={`rounded-md font-medium transition disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
    />
  );
}
