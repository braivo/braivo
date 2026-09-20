import { cn } from "cn"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

// Braivo: `strokeWidth` omitted, since the icon takes a number and SVG props allow a string.
function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth">) {
  return (
    <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
