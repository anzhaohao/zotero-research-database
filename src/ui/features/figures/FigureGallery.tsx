import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { resolvePrimaryPdf } from "../../../services/primaryPdf";
import {
  getPdfRegionThumbnail,
  mineruFigureRenderPlan,
} from "../../../services/pdfThumbnail";
import {
  openZoteroFigureImage,
  openZoteroFigureSource,
  readZoteroFigureImage,
} from "../../../services/zoteroFigure";
import { getPref } from "../../../utils/prefs";
import { FormulaCopyButton, FormulaRenderer } from "./FormulaRenderer";
import {
  type FigureRecord,
  figureImageSignature,
  isZoteroFigureRecord,
} from "./figureRecords";

export function FigureGallery({
  item,
  figures,
}: {
  item: Zotero.Item;
  figures: FigureRecord[];
}) {
  if (!figures.length)
    return <span className="zrdb-figures-empty">尚未提取</span>;
  return (
    <div className="zrdb-figure-gallery">
      {figures.map((figure) => (
        <FigureThumbnail
          key={`${figure.id}:${figureImageSignature(figure)}`}
          item={item}
          figure={figure}
        />
      ))}
    </div>
  );
}

export function FigureThumbnail({
  item,
  figure,
}: {
  item: Zotero.Item;
  figure: FigureRecord;
}) {
  const [dataUrl, setDataUrl] = useState<string>();
  const [imagePath, setImagePath] = useState<string>();
  const [missing, setMissing] = useState(false);
  const clickTimer = useRef<FigureClickTimer | undefined>(undefined);
  const latex =
    isZoteroFigureRecord(figure) && figure.kind === "formula"
      ? figure.latex?.trim()
      : undefined;
  const imageSignature = figureImageSignature(figure);
  useEffect(() => {
    let alive = true;
    setDataUrl(undefined);
    setImagePath(undefined);
    setMissing(false);
    void (async () => {
      try {
        if (isZoteroFigureRecord(figure)) {
          const image = await readZoteroFigureImage(figure);
          if (!alive) return;
          if (!image.dataUrl) {
            setMissing(true);
            return;
          }
          setDataUrl(image.dataUrl);
          setImagePath(image.path);
          return;
        }
        const renderPlan = mineruFigureRenderPlan(
          Boolean(figure.rect),
          String(getPref("figureImageQuality") || "high"),
        );
        if (figure.rect && renderPlan.previewWidth) {
          const rendered = await getPdfRegionThumbnail(
            item,
            figure.pageIndex,
            figure.rect,
            renderPlan.previewWidth,
          );
          if (!alive) return;
          if (rendered.dataUrl) {
            setDataUrl(rendered.dataUrl);
            setImagePath(rendered.path);
            return;
          }
        }
        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
          item.libraryID,
          figure.attachmentKey,
        );
        if (!alive) return;
        if (!attachment) {
          setMissing(true);
          return;
        }
        const path = await attachment.getFilePathAsync();
        if (!alive) return;
        if (!path) {
          setMissing(true);
          return;
        }
        // Zotero 9.0.6 implements this as async even though the published
        // zotero-types declaration still says it returns a string.
        const generated = await Promise.resolve(
          Zotero.File.generateDataURI(
            path,
            imageContentType(
              path,
              String((attachment as any).attachmentContentType || ""),
            ),
          ) as unknown as string | Promise<string>,
        );
        if (!alive) return;
        if (
          typeof generated !== "string" ||
          !generated.startsWith("data:image/")
        ) {
          setMissing(true);
          return;
        }
        setDataUrl(generated);
      } catch {
        if (alive) setMissing(true);
      }
    })();
    return () => {
      alive = false;
      cancelFigureClick(clickTimer);
    };
  }, [imageSignature, item.libraryID]);

  const openImage = async () => {
    if (isZoteroFigureRecord(figure)) {
      await openZoteroFigureImage(figure);
      return;
    }
    const renderPlan = mineruFigureRenderPlan(
      Boolean(figure.rect),
      String(getPref("figureImageQuality") || "high"),
    );
    if (figure.rect && renderPlan.openWidth) {
      const full = await getPdfRegionThumbnail(
        item,
        figure.pageIndex,
        figure.rect,
        renderPlan.openWidth,
      );
      if (full.path && (await IOUtils.exists(full.path)))
        await Zotero.launchFile(full.path);
      return;
    }
    if (imagePath && (await IOUtils.exists(imagePath))) {
      await Zotero.launchFile(imagePath);
      return;
    }
    const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
      item.libraryID,
      figure.attachmentKey,
    );
    if (!attachment) return;
    const path = await attachment.getFilePathAsync();
    if (path) await Zotero.launchFile(path);
  };

  const openPdf = async () => {
    if (isZoteroFigureRecord(figure)) {
      await openZoteroFigureSource(figure, item);
      return;
    }
    let pdf = figure.sourcePdfAttachmentKey
      ? await Zotero.Items.getByLibraryAndKeyAsync(
          item.libraryID,
          figure.sourcePdfAttachmentKey,
        )
      : false;
    if (!pdf) pdf = (await resolvePrimaryPdf(item))?.attachment || false;
    if (!pdf) return;
    const location = figure.rect
      ? {
          position: {
            pageIndex: figure.pageIndex,
            rects: [
              [
                figure.rect.x,
                figure.rect.y,
                figure.rect.x + figure.rect.width,
                figure.rect.y + figure.rect.height,
              ],
            ],
          },
        }
      : { pageIndex: figure.pageIndex };
    if ((Zotero.Reader as any)?.open)
      await (Zotero.Reader as any).open(pdf.id, location);
    else await (Zotero.FileHandlers as any).open(pdf, { location });
  };

  return (
    <div className="zrdb-figure-card">
      <FigurePreviewButton
        title={`${figure.kind === "figure" ? "图" : figure.kind === "table" ? "表" : "公式"} · 第 ${figure.pageIndex + 1} 页\n${figure.caption}`}
        clickTimer={clickTimer}
        onOpenImage={openImage}
        onOpenPdf={openPdf}
      >
        <span className="zrdb-figure-image-frame">
          {dataUrl ? (
            <img
              src={dataUrl}
              alt={figure.caption || figure.id}
              loading="lazy"
              onError={() => {
                setDataUrl(undefined);
                setMissing(true);
              }}
            />
          ) : !latex ? (
            <span>{missing ? "图片无法读取" : "正在加载图片"}</span>
          ) : null}
          {latex && <FormulaRenderer latex={latex} />}
        </span>
        <span className="zrdb-figure-caption">
          <small>
            {figure.kind === "figure"
              ? "图"
              : figure.kind === "table"
                ? "表"
                : "公式"}{" "}
            {figure.pageIndex + 1}
          </small>
          {figure.caption && <span>{figure.caption}</span>}
        </span>
      </FigurePreviewButton>
      {latex && <FormulaCopyButton latex={latex} />}
    </div>
  );
}

export type FigureClickTimer = {
  id: number;
  view: Pick<Window, "setTimeout" | "clearTimeout">;
};

function cancelFigureClick(timer: RefObject<FigureClickTimer | undefined>) {
  if (!timer.current) return;
  timer.current.view.clearTimeout(timer.current.id);
  timer.current = undefined;
}

export function FigurePreviewButton({
  title,
  clickTimer,
  onOpenImage,
  onOpenPdf,
  children,
}: {
  title: string;
  clickTimer: RefObject<FigureClickTimer | undefined>;
  onOpenImage: () => void | Promise<void>;
  onOpenPdf: () => void | Promise<void>;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="zrdb-figure-thumb"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        const view = event.currentTarget.ownerDocument?.defaultView;
        if (!view) return;
        cancelFigureClick(clickTimer);
        const id = view.setTimeout(() => {
          clickTimer.current = undefined;
          void onOpenImage();
        }, 220);
        clickTimer.current = { id, view };
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        cancelFigureClick(clickTimer);
        void onOpenPdf();
      }}
    >
      {children}
    </button>
  );
}

export function imageContentType(path: string, stored: string): string {
  if (stored.startsWith("image/")) return stored;
  const extension = path.split(".").pop()?.toLocaleLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "tif" || extension === "tiff") return "image/tiff";
  if (extension === "bmp") return "image/bmp";
  return "image/png";
}
