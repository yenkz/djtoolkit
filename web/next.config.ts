import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone" removed — Vercel handles deployment natively
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.salarazzmatazz.com" },
      { protocol: "https", hostname: "inputbcn.com" },
      { protocol: "https", hostname: "firebase.storage.googleapis.com" },
      { protocol: "https", hostname: "images.discotech.me" },
      { protocol: "https", hostname: "cdn.sanity.io" },
      { protocol: "https", hostname: "upload.wikimedia.org" },
      { protocol: "https", hostname: "djmag.com" },
      { protocol: "https", hostname: "www.mibsas.com" },
      { protocol: "https", hostname: "www.night-aires.com" },
      { protocol: "https", hostname: "sala-apolo.com" },
      { protocol: "https", hostname: "moogbarcelona.com" },
      { protocol: "https", hostname: "poble-espanyol.com" },
      { protocol: "https", hostname: "macarenaclub.com" },
      { protocol: "https", hostname: "estaticos.esmadrid.com" },
      { protocol: "https", hostname: "images.sk-static.com" },
      { protocol: "https", hostname: "www.labtheclub.com" },
      { protocol: "https", hostname: "www.elfest.es" },
      { protocol: "https", hostname: "media.nox-agency.com" },
      { protocol: "https", hostname: "la3club.com" },
      { protocol: "https", hostname: "www.we-heart.com" },
      { protocol: "https", hostname: "white-ibiza.com" },
      { protocol: "https", hostname: "www.dontdiewondering.com" },
      { protocol: "https", hostname: "magic-ibiza.com" },
      { protocol: "https", hostname: "static.ra.co" },
      { protocol: "https", hostname: "viberate-upload.ams3.cdn.digitaloceanspaces.com" },
      { protocol: "https", hostname: "hebbkx1anhila5yf.public.blob.vercel-storage.com" },
      { protocol: "https", hostname: "inmendoza.com" },
    ],
  },
};

export default nextConfig;
