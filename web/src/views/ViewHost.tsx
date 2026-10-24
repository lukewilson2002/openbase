import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import type { BaseSchema, Table, View } from "@/api/types";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSpinner } from "@/components/ui/spinner";
import { getViewComponent } from "./registry";

class ViewErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  override state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    // Switching to another view clears a previous crash.
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("View crashed", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <EmptyState
          icon={<TriangleAlert />}
          title="This view hit a problem"
          description={this.state.error.message}
          action={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
        />
      );
    }
    return this.props.children;
  }
}

export interface ViewHostProps {
  schema: BaseSchema;
  table: Table;
  view: View;
}

/** Extension point: renders the registered component for the view's type. */
export function ViewHost({ schema, table, view }: ViewHostProps) {
  const ViewComponent = getViewComponent(view.type);
  return (
    <ViewErrorBoundary resetKey={view.id}>
      <Suspense fallback={<PageSpinner label="Loading view" />}>
        {/* Keyed by the view: moving between two views of one type starts the next one fresh, with none of the previous one's drafts, screens or open dialogs. */}
        <ViewComponent key={view.id} schema={schema} table={table} view={view} role={schema.role} />
      </Suspense>
    </ViewErrorBoundary>
  );
}
