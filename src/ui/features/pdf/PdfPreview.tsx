import React, { useEffect, useState } from "react";
import {
  getPdfPageCount,
  getPdfThumbnail,
} from "../../../services/pdfThumbnail";

export function PdfPreview({
  item,
  thumbnailWidth,
}: {
  item: Zotero.Item;
  thumbnailWidth: number;
}) {
  const [pageCount, setPageCount] = useState<number>();
  const [visiblePages, setVisiblePages] = useState(3);
  useEffect(() => {
    let alive = true;
    setPageCount(undefined);
    setVisiblePages(3);
    void getPdfPageCount(item).then((next) => {
      if (alive) setPageCount(next);
    });
    return () => {
      alive = false;
    };
  }, [item]);
  const renderedPageCount = Math.min(Math.max(pageCount || 1, 1), visiblePages);
  const pages = Array.from(
    { length: renderedPageCount },
    (_, index) => index + 1,
  );
  return (
    <div
      className="zrdb-pdf-thumbnail-stack"
      aria-label={pageCount ? `PDF 缩略图，共 ${pageCount} 页` : "PDF 缩略图"}
      style={
        {
          "--zrdb-pdf-thumbnail-width": `${thumbnailWidth}px`,
        } as React.CSSProperties
      }
      onScroll={(event) => {
        const target = event.currentTarget;
        if (
          pageCount &&
          visiblePages < pageCount &&
          target.scrollTop + target.clientHeight >= target.scrollHeight - 24
        ) {
          setVisiblePages((current) => Math.min(pageCount, current + 2));
        }
      }}
    >
      {pages.map((page) => (
        <PdfThumbnailPage
          item={item}
          page={page}
          thumbnailWidth={thumbnailWidth}
          key={page}
        />
      ))}
      {pageCount && visiblePages < pageCount && (
        <span className="zrdb-pdf-thumbnail-more">继续向下滚动加载</span>
      )}
    </div>
  );
}

export function PdfThumbnailPage({
  item,
  page,
  thumbnailWidth,
}: {
  item: Zotero.Item;
  page: number;
  thumbnailWidth: number;
}) {
  const [result, setResult] =
    useState<Awaited<ReturnType<typeof getPdfThumbnail>>>();
  useEffect(() => {
    let alive = true;
    void getPdfThumbnail(item, thumbnailWidth, page).then((next) => {
      if (alive) setResult(next);
    });
    return () => {
      alive = false;
    };
  }, [item, page, thumbnailWidth]);
  if (!result?.dataUrl) {
    return (
      <span className="zrdb-pdf-placeholder">
        {result?.reason === "unreadable" ? "PDF 不可读" : "PDF"}
      </span>
    );
  }
  return (
    <span className="zrdb-pdf-thumb-page">
      <img
        className="zrdb-pdf-thumb"
        src={result.dataUrl}
        alt={`PDF 第 ${page} 页`}
      />
      <small>{page}</small>
    </span>
  );
}
