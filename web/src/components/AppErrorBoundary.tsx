import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { ErrorState } from "./ErrorState";

class Boundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean; key: string }> {
  override state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    // Going to another page clears a crash, so Go to Home is a way out.
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The app crashed", error, info.componentStack);
  }

  override render() {
    if (this.state.failed) {
      return <ErrorState title="Something went wrong" happened="This page stopped working." todo="Go to Home, or reload the page to try again." className="min-h-dvh justify-center" />;
    }
    return this.props.children;
  }
}

/** Last resort for a page that throws while drawing: the screen says so and leads Home instead of staying blank (APP-17). */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <Boundary resetKey={useLocation().pathname}>{children}</Boundary>;
}
