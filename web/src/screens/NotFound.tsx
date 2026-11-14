import { Link } from "react-router";
import { paths } from "../app/routes.ts";
import { EmptyState } from "../components/States.tsx";

export function NotFound() {
  return <div className="page"><EmptyState title="Page not found" action={<Link className="btn btn-primary" to={paths.inbox()}>Go to inbox</Link>}>That address doesn't match any screen in the order desk.</EmptyState></div>;
}
