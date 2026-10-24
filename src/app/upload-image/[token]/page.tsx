import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Icon } from "@/components/icons";
import { getSessionUser } from "@/lib/auth";
import { HttpError } from "@/lib/api";
import { getProductImageUploadDetails } from "@/lib/product-image-upload-tokens";
import { UploadImageForm } from "./upload-image-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Upload product image · Star Stock",
  robots: { index: false, follow: false },
};

type PageProps = { params: Promise<{ token: string }> };

function UploadLinkError({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-5 py-12">
      <section className="w-full max-w-lg rounded-xl border border-line bg-card p-6 shadow-sm sm:p-8">
        <div className="flex items-start gap-3 text-out">
          <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0" />
          <h1 className="font-display text-xl font-bold tracking-tight">Unable to upload image</h1>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">{message}</p>
        <p className="mt-5 text-xs leading-relaxed text-ink-faint">
          Ask your AI assistant to request a new upload link if this one has expired or was already used.
        </p>
      </section>
    </main>
  );
}

export default async function UploadImagePage({ params }: PageProps) {
  const { token } = await params;
  const user = await getSessionUser();
  if (!user) {
    const next = `/upload-image/${encodeURIComponent(token)}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  let product: Awaited<ReturnType<typeof getProductImageUploadDetails>> | null = null;
  let linkError: string | null = null;
  try {
    product = await getProductImageUploadDetails(token, user.id);
  } catch (error) {
    if (error instanceof HttpError) linkError = error.message;
    else throw error;
  }

  if (linkError) return <UploadLinkError message={linkError} />;
  if (!product) throw new Error("Product upload details were not available.");

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-5 py-12">
      <section className="w-full max-w-lg rounded-xl border border-line bg-card p-6 shadow-sm sm:p-8">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-faint">Star Stock · Product photo</p>
        <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">Upload product image</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Add a photo for <span className="font-semibold text-ink">{product.name || "Unnamed product"}</span>.
        </p>
        <p className="mt-3 inline-flex items-center rounded-md bg-surface px-2.5 py-1 font-mono text-xs font-semibold text-ink ring-1 ring-line">
          SKU: {product.sku}
        </p>
        <div className="mt-6">
          <UploadImageForm token={token} sku={product.sku} />
        </div>
        <p className="mt-5 text-[11px] leading-relaxed text-ink-faint">
          This private link can be used once and expires after 15 minutes.
        </p>
      </section>
    </main>
  );
}
