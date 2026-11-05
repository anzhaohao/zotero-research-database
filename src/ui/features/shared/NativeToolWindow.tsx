import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { config } from "../../../../package.json";

/** A modeless native window; React retains task state while it is minimized. */
export function NativeToolWindow({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const [host, setHost] = useState<HTMLElement>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let disposing = false;
    const dialog = new addon.data.ztoolkit.Dialog(1, 1);
    dialog.setDialogData({
      loadCallback: () => {
        const doc = dialog.window.document as unknown as Document;
        doc.title = title;
        doc.documentElement!.setAttribute(
          "windowtype",
          "zrdb:document-processing",
        );
        const css = doc.createElement("link");
        css.rel = "stylesheet";
        css.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
        doc.head!.append(css);
        (doc.documentElement as HTMLElement).style.colorScheme = "light dark";
        doc.body!.className = "zrdb-native-tool-window";
        doc.body!.replaceChildren();
        const container = doc.createElement("main");
        container.className = "zrdb-native-tool-content zrdb-modal";
        container.setAttribute("role", "region");
        container.setAttribute("aria-label", title);
        doc.body!.append(container);
        dialog.window.addEventListener("close", (event) => {
          if (disposing) return;
          event.preventDefault();
          closeRef.current();
        });
        setHost(container);
      },
      unloadCallback: () => {
        if (!disposing) closeRef.current();
      },
    });
    dialog.open(title, {
      width: 1060,
      height: 720,
      centerscreen: true,
      resizable: true,
      fitContent: false,
      noDialogMode: true,
    });
    return () => {
      disposing = true;
      if (!dialog.window.closed) dialog.window.close();
    };
  }, [title]);
  return host ? createPortal(children, host) : null;
}
