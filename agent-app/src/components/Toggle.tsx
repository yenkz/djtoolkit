interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export default function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
  return (
    <label className={`toggle-container ${disabled ? "toggle-disabled" : ""}`}>
      <span className="toggle-label">{label}</span>
      <div
        className={`toggle-track ${checked ? "toggle-on" : ""}`}
        onClick={() => !disabled && onChange(!checked)}
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            if (!disabled) onChange(!checked);
          }
        }}
      >
        <div className="toggle-thumb" />
      </div>
    </label>
  );
}
