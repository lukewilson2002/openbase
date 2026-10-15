/**
 * Gallery view: a responsive grid of record cards (cover image, title, visible fields) loaded
 * page by page as you scroll.
 */
import { useEffect, useMemo, useRef } from "react";
import { Crop } from "lucide-react";
import type { ViewConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { CardBody } from "../common/CardBody";
import { cardFields, cardTitle, itemsLabel } from "../common/cardFields";
import { EmptyRecords } from "../common/EmptyRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, ViewSettings } from "../common/ViewSettings";
import { ViewFrame } from "../common/ViewFrame";
import type { ViewProps } from "../types";
import { useGalleryData } from "./useGalleryData";

export default function GalleryView(props: ViewProps) {
  return <GalleryInner key={props.view.id} {...props} />;
}

function setGallery(c: ViewConfig, patch: Partial<ViewConfig["gallery"]>): ViewConfig {
  return { ...c, gallery: { ...c.gallery, ...patch } };
}

function GalleryInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes } = setup;
  const attachmentFields = useMemo(() => table.fields.filter((f) => f.type === "attachment"), [table.fields]);
  const coverField = attachmentFields.find((f) => f.id === config.gallery.cover_field_id);
  const crop = config.gallery.cover_crop;
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const fields = useMemo(() => cardFields(table, config, new Set([coverField?.id ?? ""])), [table, config, coverField?.id]);

  const data = useGalleryData({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone: setup.timeZone, transient: setup.transient });

  // Infinite scroll: load the next page when the sentinel below the cards comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore } = data;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, data.records.length]);

  const addRecord = async () => {
    const rec = await writes.create({});
    if (rec) setup.openRecord(rec.id);
  };

  const note = cfg.canConfigure ? undefined : "You do not have permission to change this view.";
  const settings = (
    <ViewSettings label={coverField ? `Cover: ${coverField.name}` : "Cover"} active={!!coverField} note={note}>
      <FieldSelect
        label="Cover image"
        fields={attachmentFields}
        value={coverField?.id ?? ""}
        noneLabel="No cover"
        disabled={!cfg.canConfigure}
        onChange={(id) => cfg.update((c) => setGallery(c, { cover_field_id: id }))}
        hint={attachmentFields.length === 0 ? "Add an attachment field to show pictures on the cards." : "Cards show the first image of this field, when they have one."}
      />
    </ViewSettings>
  );

  const recordIds = useMemo(() => data.records.map((r) => r.id), [data.records]);

  return (
    <ViewFrame
      setup={setup}
      recordIds={recordIds}
      layout="bare"
      features={{ group: false, rowHeight: false }}
      toolbarSetting={settings}
      moreToggles={[
        {
          id: "crop",
          label: "Crop cover images",
          icon: <Crop aria-hidden />,
          checked: crop,
          disabled: !cfg.canConfigure || !coverField,
          onToggle: (on) => cfg.update((c) => setGallery(c, { cover_crop: on })),
        },
      ]}
      onAdd={setup.canEdit ? () => void addRecord() : undefined}
      footer={
        data.loading ? undefined : (
          <>
            <span aria-live="polite">
              {data.total > data.records.length ? `${data.records.length.toLocaleString()} of ${itemsLabel(data.total)}` : itemsLabel(data.total)}
              {setup.debouncedSearch ? " found" : ""}
            </span>
            {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
          </>
        )
      }
    >
      <div className="p-3 pb-2.5 md:p-4 md:pb-2.5">
        {data.loading ? (
          <div className="flex justify-center pt-16">
            <Spinner className="size-5" label="Loading records" />
          </div>
        ) : data.error && data.records.length === 0 ? (
          <p role="alert" className="pt-16 text-center text-[0.8125rem] text-muted">
            Could not load records: {data.error.message}
          </p>
        ) : (
          <>
            <div role="list" aria-label="Records" className="grid items-start gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
              {data.records.map((rec) => {
                const open = () => setup.openRecord(rec.id);
                return (
                  <div
                    key={rec.id}
                    role="listitem"
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={cardTitle(primary, rec, setup.format)}
                      data-record-id={rec.id}
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest("a")) open();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                      className="relative cursor-pointer overflow-hidden rounded-xl border border-line bg-surface text-left outline-none transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-[0_4px_12px_rgb(15_20_30/0.08)] focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <CardBody
                        record={rec}
                        primary={primary}
                        fields={fields}
                        coverField={coverField}
                        coverFit={crop ? "cover" : "contain"}
                        coverHeight={132}
                        layout="stacked"
                        format={setup.format}
                        emails={setup.emails}
                        color={data.colors[rec.id]}
                        limit={5}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {data.records.length === 0 && (
              // Cards sit straight on the page, so the empty state gets a card of its own to sit in.
              <div className="rounded-xl border border-line bg-surface">
                <EmptyRecords searching={!!setup.debouncedSearch} onAdd={setup.canEdit ? () => void addRecord() : undefined} />
              </div>
            )}
            <div ref={sentinel} className={cn("flex items-center justify-center", (data.hasMore || data.loadingMore) && "h-16")}>
              {data.loadingMore ? (
                <Spinner className="size-4" label="Loading more" />
              ) : (
                data.hasMore && (
                  <Button size="sm" onClick={data.loadMore}>
                    Load more
                  </Button>
                )
              )}
            </div>
          </>
        )}
      </div>
    </ViewFrame>
  );
}
