import { Link } from "react-router";
import { EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <EmptyState title="Page not found" description="This page doesn't exist.">
      <Button variant="outline" size="sm" asChild>
        <Link to="/functions">Go to functions</Link>
      </Button>
    </EmptyState>
  );
}
