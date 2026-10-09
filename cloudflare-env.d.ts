declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    LIVEKIT_URL?: string;
    LIVEKIT_API_KEY?: string;
    LIVEKIT_API_SECRET?: string;
    R2_S3_ENDPOINT?: string;
    R2_S3_ACCESS_KEY?: string;
    R2_S3_SECRET_KEY?: string;
    R2_S3_BUCKET?: string;
    PUBLIC_SITE_URL?: string;
    FILES?: R2Bucket;
    CONVERTER_URL?: string;
    CONVERTER_SECRET?: string;
  }
}
