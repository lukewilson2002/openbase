import { Skeleton } from "@/components/ui/skeleton";

/** The rows of a feed card while its data is on the way, in the shape of the rows. */
export function FeedLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex flex-col gap-3 p-3" role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0" />
          <div className="flex-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-1.5 h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

