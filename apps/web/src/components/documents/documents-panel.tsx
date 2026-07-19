"use client";

import { Broom } from "@phosphor-icons/react";
import { useState, useTransition } from "react";
import { sweepOrphanedUploads } from "@/app/(app)/documents/actions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type DocumentRow, useDocumentFeed } from "@/lib/documents/use-document-feed";
import { DocumentCard } from "./document-card";
import { UploadDialog } from "./upload-dialog";

export interface CourseOption {
  readonly id: string;
  readonly title: string;
}

/**
 * The documents screen's client half: course picker, upload, and the live list.
 *
 * Documents are scoped to a course because everything downstream is — topics,
 * chunks and the exam review are all per-course, and `postgres_changes` filters
 * on a single column value, so "all my documents" would need one subscription
 * per course rather than one subscription.
 *
 * The initial rows are server-rendered and handed in, so the list is correct on
 * first paint with no client round trip; `useDocumentFeed` then subscribes and
 * backfills over the top. See that module for why the backfill is the
 * authoritative read and Realtime is the accelerator.
 */
export function DocumentsPanel({
  courses,
  userId,
  initialCourseId,
  initialDocuments,
}: {
  courses: readonly CourseOption[];
  userId: string;
  initialCourseId: string | null;
  initialDocuments: readonly DocumentRow[];
}) {
  const [courseId, setCourseId] = useState<string | null>(initialCourseId);
  const [sweeping, startSweep] = useTransition();
  const [sweptMessage, setSweptMessage] = useState<string | null>(null);

  // Only seed from the server render for the course it was rendered for.
  // Switching course must not show the previous course's documents for a frame.
  const { documents, events, refresh } = useDocumentFeed(
    courseId,
    courseId === initialCourseId ? initialDocuments : [],
  );

  const courseItems = Object.fromEntries(courses.map((course) => [course.id, course.title]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-muted-foreground text-ui-xs">Course</span>
          <Select
            items={courseItems}
            value={courseId ?? ""}
            onValueChange={(value) => setCourseId(value)}
          >
            <SelectTrigger className="w-72 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {courses.map((course) => (
                <SelectItem key={course.id} value={course.id}>
                  {course.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {courseId !== null ? (
          <UploadDialog courseId={courseId} userId={userId} onUploaded={refresh} />
        ) : null}
      </div>

      {documents.length === 0 ? (
        <p className="rounded-lg border border-border border-dashed bg-surface px-4 py-8 text-center text-muted-foreground text-ui-sm">
          Nothing uploaded to this course yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {documents.map((document) => (
            <DocumentCard key={document.id} document={document} events={events} />
          ))}
        </ul>
      )}

      {/*
       * The orphan sweep (gate 1 finding F5).
       *
       * Deliberately a visible, manual affordance rather than something that
       * runs on page load. A sweep deletes storage objects, and a delete that
       * fires automatically on a screen the user did not ask to clean is the
       * kind of thing that is fine until the one time it isn't. It is also
       * rare — the inline cleanup in `registerUpload` handles every failure the
       * browser is still around to see, so this is for the closed-tab case.
       */}
      {courseId !== null ? (
        <div className="flex flex-wrap items-center gap-3 border-border border-t pt-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={sweeping}
            onClick={() =>
              startSweep(async () => {
                const result = await sweepOrphanedUploads({ courseId });
                setSweptMessage(
                  result.message ??
                    (result.removed === 0
                      ? "No leftover files to clear."
                      : `Cleared ${result.removed} leftover file${result.removed === 1 ? "" : "s"}.`),
                );
                refresh();
              })
            }
          >
            <Broom aria-hidden className="size-3.5" />
            Clear leftover uploads
          </Button>
          <span className="text-muted-foreground text-ui-xs">
            {sweptMessage ??
              "Removes files from interrupted uploads that never finished registering."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
