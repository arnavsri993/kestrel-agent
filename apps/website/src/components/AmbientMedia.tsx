"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { sitePath } from "../lib/site-path";

export interface VisualAsset {
  id: string;
  purpose: string;
  posterPath: string;
  mp4Path?: string;
  webmPath?: string;
  mobilePosterPath?: string;
  mobileMp4Path?: string;
  mobileWebmPath?: string;
  width: number;
  height: number;
  durationSeconds?: number;
  muted: boolean;
  loop: boolean;
  checksum: string;
  sourceManifestId: string;
  status: "draft" | "approved" | "published";
}

export function AmbientMedia({ asset, className = "" }: { asset: VisualAsset; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const hasPublishedVideo = asset.status === "published" && Boolean(asset.mp4Path || asset.webmPath);

  useEffect(() => {
    if (!container.current || reduced || !hasPublishedVideo) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { threshold: 0.18 });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [hasPublishedVideo, reduced]);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const sync = () => { if (visible && !document.hidden) void element.play().catch(() => undefined); else element.pause(); };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [visible]);

  const poster = sitePath((asset.mobilePosterPath ?? asset.posterPath) as `/${string}`);
  const desktopPoster = sitePath(asset.posterPath as `/${string}`);
  return <div ref={container} className={`ambient-media ${className}`} aria-hidden="true">
    {reduced || !hasPublishedVideo ? <picture><source media="(max-width: 700px)" srcSet={poster}/><img src={desktopPoster} alt="" /></picture> : <video ref={video} muted={asset.muted} loop={asset.loop} playsInline preload="none" poster={desktopPoster}>
      {asset.webmPath && <source src={sitePath(asset.webmPath as `/${string}`)} type="video/webm" />}
      {asset.mp4Path && <source src={sitePath(asset.mp4Path as `/${string}`)} type="video/mp4" />}
    </video>}
  </div>;
}
