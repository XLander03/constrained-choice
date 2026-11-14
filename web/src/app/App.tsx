import { Navigate, RouterProvider, createBrowserRouter, useRouteError } from "react-router";
import { ApiProvider } from "./api-context.tsx";
import { Layout } from "./Layout.tsx";
import { patterns, paths } from "./routes.ts";
import { ErrorState } from "../components/States.tsx";
import { InboxScreen } from "../screens/InboxScreen.tsx";
import { ReviewScreen } from "../screens/review/ReviewScreen.tsx";
import { ApprovedScreen } from "../screens/ApprovedScreen.tsx";
import { CatalogScreen } from "../screens/CatalogScreen.tsx";
import { StatsScreen } from "../screens/StatsScreen.tsx";
import { NotFound } from "../screens/NotFound.tsx";

function RouteError() {
  const err = useRouteError();
  return <div className="page"><ErrorState title="This screen crashed" error={err instanceof Error ? err : new Error(String(err))} onRetry={() => location.reload()} /></div>;
}

const router = createBrowserRouter([
  {
    path: "/", element: <Layout />, errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to={paths.inbox()} replace /> },
      { path: patterns.inbox, element: <InboxScreen />, errorElement: <RouteError /> },
      { path: patterns.review, element: <ReviewScreen />, errorElement: <RouteError /> },
      { path: "orders", element: <Navigate to={`${paths.inbox()}?filter=needs_review`} replace /> },
      { path: patterns.approved, element: <ApprovedScreen />, errorElement: <RouteError /> },
      { path: patterns.catalog, element: <CatalogScreen />, errorElement: <RouteError /> },
      { path: patterns.stats, element: <StatsScreen />, errorElement: <RouteError /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return <ApiProvider><RouterProvider router={router} /></ApiProvider>;
}
