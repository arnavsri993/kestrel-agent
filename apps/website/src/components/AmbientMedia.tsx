"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

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

  const poster = asset.mobilePosterPath ?? asset.posterPath;
  return <div ref={container} className={`ambient-media ${className}`} aria-hidden="true">
    {reduced || !hasPublishedVideo ? <picture><source media="(max-width: 700px)" srcSet={poster}/><img src={asset.posterPath} alt="" /></picture> : <video ref={video} muted={asset.muted} loop={asset.loop} playsInline preload="none" poster={asset.posterPath}>
      {asset.webmPath && <source src={asset.webmPath} type="video/webm" />}
      {asset.mp4Path && <source src={asset.mp4Path} type="video/mp4" />}
    </video>}
  </div>;
}
