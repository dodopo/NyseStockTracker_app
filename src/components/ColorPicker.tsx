import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { TAB_COLORS } from "../../shared/assetTypes";

/** Color choice for tabs and portfolios (the same palette, validated on the server). */
export function ColorPicker({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {TAB_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={`Cor ${color}`}
          onClick={() => onChange(color)}
          className={cn(
            "h-6 w-6 rounded-full border-2 flex items-center justify-center",
            value === color ? "border-white" : "border-transparent hover:border-white/40"
          )}
          style={{ background: color }}
        >
          {value === color && <Check size={12} className="text-white" />}
        </button>
      ))}
    </div>
  );
}
