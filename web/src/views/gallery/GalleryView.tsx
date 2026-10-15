/**
 * Gallery view: a responsive grid of record cards (cover image, title, visible fields) loaded
 * page by page as you scroll.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ViewConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";
import { CardBody } from "../common/CardBody";
import { cardFields, cardTitle } from "../common/cardFields";
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
    <ViewSettings label="Gallery settings" note={note}>
      <FieldSelect label="Cover image" fields={attachmentFields} value={coverField?.id ?? ""} noneLabel="No cover" disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setGallery(c, { cover_field_id: id }))} hint="Shows the first image of an attachment field." />
      <Switch label="Crop images to fill the card" checked={crop} disabled={!cfg.canConfigure || !coverField} onCheckedChange={(on) => cfg.update((c) => setGallery(c, { cover_crop: on }))} />
    </ViewSettings>
  );

  const recordIds = useMemo(() => data.records.map((r) => r.id), [data.records]);

  return (
    <ViewFrame
      setup={setup}
      recordIds={recordIds}
      features={{ group: false, rowHeight: false }}
      hideFieldsNoun="Card fields"
      toolbarExtra={settings}
      onAdd={setup.canEdit ? () => void addRecord() : undefined}
      footer={
        <>
          <span aria-live="polite">
            {data.records.length.toLocaleString()}
            {data.total > data.records.length ? ` of ${data.total.toLocaleString()}` : ""} record{data.total === 1 ? "" : "s"}
            {setup.debouncedSearch ? " found" : ""}
          </span>
          {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
        </>
      }
    >
      <div className="h-full overflow-y-auto p-3">
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
            <div role="list" aria-label="Records" className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))" }}>
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
                      className={cn("relative h-full cursor-pointer overflow-hidden rounded-lg border border-line bg-surface text-left shadow-sm outline-none hover:border-line-strong focus-visible:outline-2 focus-visible:outline-ring")}
                    >
                      <CardBody
                        record={rec}
                        primary={primary}
                        fields={fields}
                        coverField={coverField}
                        coverFit={crop ? "cover" : "contain"}
                        coverHeight={160}
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
            {data.records.length === 0 && <p className="pt-10 text-center text-[0.8125rem] text-muted">{setup.debouncedSearch ? "No records match your search." : "No records yet."}</p>}
            <div ref={sentinel} className="flex h-16 items-center justify-center">
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
