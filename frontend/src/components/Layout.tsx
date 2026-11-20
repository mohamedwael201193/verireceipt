import { NavLink, Outlet } from "react-router-dom";

// Minimal scaffold layout — replaced by the full Layout (nav, theme toggle,
// health pill, footer) in the layout commit.
const LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/receipts", label: "Receipts" },
  { to: "/benchmarks", label: "Benchmarks" },
  { to: "/status", label: "Status" },
  { to: "/docs", label: "Docs" },
];

export default function Layout() {
  return (
    <div>
      <nav aria-label="Primary">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end}>
            {l.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
