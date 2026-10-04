import { cn } from "cn"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

// Braivo: `strokeWidth` omitted, since the icon takes a number and SVG props allow a string.
// Braivo: with reduced motion it fades rather than turns, so it still shows work going on.
function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth">) {
  return (
    <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin motion-reduce:animate-pulse", className)} {...props} />
  )
}

export { Spinner }
