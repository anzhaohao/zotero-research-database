import React, { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { researchDisplayBlocks } from "../../../core/researchText";
import { getPref } from "../../../utils/prefs";

gsap.registerPlugin(useGSAP);

export function ResearchTextValue({
  value,
  fieldName,
}: {
  value: unknown;
  fieldName: string;
}) {
  const blocks = researchDisplayBlocks(value, fieldName);
  if (!blocks.length) return <span className="zrdb-empty-value">—</span>;
  return (
    <div className="zrdb-research-text">
      {blocks.map((block, index) => (
        <div
          className={`zrdb-research-block is-${block.kind}`}
          key={`${block.kind}-${index}`}
        >
          {block.kind === "bullet" && (
            <span className="zrdb-research-marker">{block.marker}</span>
          )}
          <span>
            {block.label && <strong>{block.label}</strong>}
            {block.label && "："}
            {block.text}
          </span>
        </div>
      ))}
    </div>
  );
}

export function prefersReducedMotion(element: Element | null): boolean {
  if (getPref("motionEnabled") === false) return true;
  const view = element?.ownerDocument?.defaultView;
  const query = view?.matchMedia?.("(prefers-reduced-motion: reduce)");
  return query?.matches === true;
}

export type IconName =
  | "agent"
  | "arrange"
  | "check"
  | "chevron"
  | "close"
  | "color"
  | "columns"
  | "compare"
  | "copy"
  | "csv"
  | "direction"
  | "edit"
  | "field"
  | "fields"
  | "folder"
  | "html"
  | "list"
  | "lock"
  | "mineru"
  | "open"
  | "print"
  | "refresh"
  | "rowColor"
  | "rowHeight"
  | "save"
  | "search"
  | "sheet"
  | "spark"
  | "table"
  | "unlock"
  | "views";

export function UIIcon({ name }: { name: IconName }) {
  let paths: React.ReactNode;
  switch (name) {
    case "list":
      paths = (
        <>
          <path d="M7 5h9M7 10h9M7 15h9" />
          <path d="M4 5h.01M4 10h.01M4 15h.01" strokeWidth="2.4" />
        </>
      );
      break;
    case "table":
      paths = (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" />
          <path d="M3 8h14M8 3v14M13 3v14" />
        </>
      );
      break;
    case "search":
      paths = (
        <>
          <circle cx="8.5" cy="8.5" r="4.5" />
          <path d="m12 12 4 4" />
        </>
      );
      break;
    case "arrange":
      paths = (
        <>
          <path d="M4 5h8M4 10h11M4 15h5" />
          <path d="m13 13 2 2 2-2M15 15V9" />
        </>
      );
      break;
    case "fields":
      paths = (
        <>
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="M8 4v12M3 9h14" />
        </>
      );
      break;
    case "views":
      paths = (
        <>
          <path d="M4 3h9l3 3v11H4z" />
          <path d="M12 3v4h4M7 11h6M7 14h4" />
        </>
      );
      break;
    case "direction":
      paths = <path d="m6 4-2 2 2 2M4 6h9M14 16l2-2-2-2M16 14H7" />;
      break;
    case "field":
      paths = (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" />
          <path d="M7 7h6M7 10h6M7 13h3" />
        </>
      );
      break;
    case "columns":
      paths = (
        <>
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="M8 4v12M13 4v12" />
        </>
      );
      break;
    case "agent":
      paths = (
        <>
          <rect x="4" y="6" width="12" height="10" rx="3" />
          <path d="M10 3v3M7.5 11h.01M12.5 11h.01M7 16v2M13 16v2" />
        </>
      );
      break;
    case "mineru":
      paths = (
        <>
          <path d="M5 3h7l3 3v11H5z" />
          <path d="M12 3v4h4M8 10h4M8 13h4" />
        </>
      );
      break;
    case "spark":
      paths = (
        <path d="m10 2 1.2 4.3L15 8l-3.8 1.7L10 14l-1.2-4.3L5 8l3.8-1.7zM15.5 13l.6 2.1L18 16l-1.9.9-.6 2.1-.6-2.1L13 16l1.9-.9z" />
      );
      break;
    case "close":
      paths = <path d="m5 5 10 10M15 5 5 15" />;
      break;
    case "refresh":
      paths = <path d="M16 7a6 6 0 1 0 .3 5M16 3v4h-4" />;
      break;
    case "save":
      paths = (
        <>
          <path d="M4 3h10l3 3v11H4z" />
          <path d="M7 3v5h7V3M7 17v-5h6v5" />
        </>
      );
      break;
    case "folder":
      paths = <path d="M3 6h6l2-2h6v12H3z" />;
      break;
    case "compare":
      paths = <path d="M7 4H4v12h3M13 4h3v12h-3M8 7h4M8 13h4M10 5v10" />;
      break;
    case "sheet":
      paths = (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" />
          <path d="M3 8h14M8 3v14M3 13h14" />
        </>
      );
      break;
    case "csv":
      paths = <path d="M5 3h7l3 3v11H5zM11 3v4h4M7 11h6M7 14h6" />;
      break;
    case "html":
      paths = <path d="m7 6-4 4 4 4M13 6l4 4-4 4M11 4 9 16" />;
      break;
    case "print":
      paths = (
        <>
          <path d="M6 7V3h8v4M6 14H4V8h12v6h-2" />
          <path d="M6 11h8v6H6z" />
        </>
      );
      break;
    case "edit":
      paths = <path d="m4 14-.5 3 3-.5L15 8 12 5zM11 6l3 3" />;
      break;
    case "check":
      paths = <path d="m4 10 4 4 8-9" />;
      break;
    case "chevron":
      paths = <path d="m5 8 5 5 5-5" />;
      break;
    case "copy":
      paths = (
        <>
          <rect x="7" y="7" width="10" height="10" rx="2" />
          <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
        </>
      );
      break;
    case "color":
      paths = (
        <path d="M10 3c3 3.4 5 5.7 5 8a5 5 0 0 1-10 0c0-2.3 2-4.6 5-8zM7 14h6" />
      );
      break;
    case "rowColor":
      paths = <path d="M3 5h14M3 10h14M3 15h14M5 3v14M15 3v14" />;
      break;
    case "rowHeight":
      paths = (
        <>
          <path d="M4 4h12M4 16h12M10 7v6" />
          <path d="m7.5 9.5 2.5-2.5 2.5 2.5M7.5 10.5 10 13l2.5-2.5" />
        </>
      );
      break;
    case "open":
      paths = <path d="M11 4h5v5M16 4l-7 7M14 11v5H4V6h5" />;
      break;
    case "lock":
      paths = <path d="M5 9h10v8H5zM7 9V6a3 3 0 0 1 6 0v3" />;
      break;
    case "unlock":
      paths = <path d="M5 9h10v8H5zM8 9V6a3 3 0 0 1 5-2" />;
      break;
  }
  return (
    <svg className="zrdb-ui-icon" viewBox="0 0 20 20" aria-hidden="true">
      {paths}
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  active = false,
  disabled = false,
  className = "",
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`zrdb-icon-button ${active ? "is-active" : ""} ${className}`}
      data-tooltip={label}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <UIIcon name={icon} />
    </button>
  );
}

export function MenuButton({
  icon,
  label,
  detail,
  disabled = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="zrdb-menu-item"
      disabled={disabled}
      onClick={onClick}
    >
      <UIIcon name={icon} />
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </button>
  );
}

export function ToolbarMenu({
  icon,
  label,
  open,
  onToggle,
  children,
}: {
  icon: IconName;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const menu = rootRef.current?.querySelector(".zrdb-menu-popover");
      if (!open || !menu || prefersReducedMotion(menu)) return;
      gsap.fromTo(
        menu,
        { autoAlpha: 0, y: -3, scale: 0.985 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.14,
          ease: "power1.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    },
    { scope: rootRef, dependencies: [open], revertOnUpdate: true },
  );
  return (
    <div className={`zrdb-toolbar-menu ${open ? "is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="zrdb-menu-trigger zrdb-icon-button"
        data-tooltip={label}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={onToggle}
      >
        <UIIcon name={icon} />
      </button>
      {open && (
        <div className="zrdb-menu-popover" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const backdrop = backdropRef.current;
      const modal = modalRef.current;
      if (!backdrop || !modal || prefersReducedMotion(backdrop)) return;
      gsap.fromTo(
        backdrop,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.12, ease: "none" },
      );
      gsap.fromTo(
        modal,
        { autoAlpha: 0, y: 4, scale: 0.99 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.17,
          ease: "power1.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    },
    { scope: backdropRef },
  );
  return (
    <div
      ref={backdropRef}
      className="zrdb-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className={`zrdb-modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button onClick={onClose}>×</button>
        </header>
        <div className="zrdb-modal-body">{children}</div>
      </section>
    </div>
  );
}
