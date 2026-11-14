import { cn } from "@/lib/utils/cn";

export function Logo({ className }: { className?: string }) {
  return (
    <svg className={cn("size-6", className)} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        fill="#4ade80"
        d="M16 2.5Q19.6 6 20.3 10.3Q25 9.4 29.5 11.6Q28.4 18.8 21.4 23.4Q18.8 25.2 16 24Q13.2 25.2 10.6 23.4Q3.6 18.8 2.5 11.6Q7 9.4 11.7 10.3Q12.4 6 16 2.5Z"
      />
      <path className="stroke-background" strokeWidth="1.5" strokeLinecap="round" d="M16 21.5V8M16 17l7.5-4.2M16 17l-7.5-4.2" />
      <path stroke="#4ade80" strokeWidth="1.8" strokeLinecap="round" d="M16 23.5c.3 2.2-.2 4-1.2 5.8" />
    </svg>
  );
}
