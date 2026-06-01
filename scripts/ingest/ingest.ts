import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type AssetType = "pdf" | "image";

interface Asset {
  type: AssetType;
  id: string;
  url: string;
  title: string;
}

interface Manifest {
  assets: Asset[];
}

interface PdfExtractionResult {
  source: string;
  content: string;
  pageCount: number;
  metadata: Record<string, unknown>;
  processedAt: string;
}

interface ImageAnalysisResult {
  source: string;
  description: string;
  caption: string;
  altText: string;
  processedAt: string;
}

interface IndexedDocument {
  id: string;
  data: {
    title: string;
    asset_type: AssetType;
    source_url: string;
    body: string;
    caption?: string;
    alt_text?: string;
    page_count?: number;
    indexed_at: string;
  };
}

interface BulkIndexResponseDocument {
  id: string;
}

interface BulkIndexResponse {
  code: string;
  success: boolean;
  documents: BulkIndexResponseDocument[];
}

const SMART_SEARCH_GRAPHQL_URL = process.env.SMART_SEARCH_GRAPHQL_URL;
const SMART_SEARCH_ACCESS_TOKEN = process.env.SMART_SEARCH_ACCESS_TOKEN;

const META_SYSTEM = "smart-search-rag-chatbot-ingest";
const META_SOURCE = "ingest-script";

function requireEnv(): { url: string; token: string } {
  if (!SMART_SEARCH_GRAPHQL_URL || !SMART_SEARCH_ACCESS_TOKEN) {
    throw new Error(
      "SMART_SEARCH_GRAPHQL_URL and SMART_SEARCH_ACCESS_TOKEN must be set in .env.local"
    );
  }
  return { url: SMART_SEARCH_GRAPHQL_URL, token: SMART_SEARCH_ACCESS_TOKEN };
}

async function gqlRequest<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const { url, token } = requireEnv();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let payload: { data?: T; errors?: Array<{ message: string }> };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Smart Search returned non-JSON response (status ${response.status}): ${text.slice(0, 200)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Smart Search HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`
    );
  }
  if (payload.errors?.length) {
    throw new Error(
      `Smart Search GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`
    );
  }
  if (!payload.data) {
    throw new Error("Smart Search response missing data field");
  }

  return payload.data;
}

const EXTRACT_PDF_QUERY = /* GraphQL */ `
  query ExtractPDF($input: PDFExtractionInput!) {
    pdf {
      extract(input: $input) {
        source
        content
        pageCount
        metadata
        processedAt
      }
    }
  }
`;

async function extractPdf(url: string): Promise<PdfExtractionResult> {
  const data = await gqlRequest<{ pdf: { extract: PdfExtractionResult } }>(
    EXTRACT_PDF_QUERY,
    {
      input: {
        source: url,
        meta: { action: "extract", system: META_SYSTEM, source: META_SOURCE },
      },
    }
  );
  return data.pdf.extract;
}

const ANALYZE_IMAGE_QUERY = /* GraphQL */ `
  query AnalyzeImage($input: ImageAnalysisInput!) {
    image {
      analyze(input: $input) {
        source
        description
        caption
        altText
        processedAt
      }
    }
  }
`;

async function analyzeImage(url: string): Promise<ImageAnalysisResult> {
  const data = await gqlRequest<{ image: { analyze: ImageAnalysisResult } }>(
    ANALYZE_IMAGE_QUERY,
    {
      input: {
        source: url,
        meta: { action: "analyze", system: META_SYSTEM, source: META_SOURCE },
      },
    }
  );
  return data.image.analyze;
}

const BULK_INDEX_MUTATION = /* GraphQL */ `
  mutation BulkIndexDocuments($input: BulkIndexInput!) {
    bulkIndex(input: $input) {
      code
      success
      documents {
        id
      }
    }
  }
`;

async function bulkIndex(documents: IndexedDocument[]): Promise<BulkIndexResponse> {
  const data = await gqlRequest<{ bulkIndex: BulkIndexResponse }>(
    BULK_INDEX_MUTATION,
    {
      input: {
        documents,
        meta: { action: "manual-index", system: META_SYSTEM, source: META_SOURCE },
      },
    }
  );
  return data.bulkIndex;
}

function loadManifest(): Manifest {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, "manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

function ms(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

async function buildDocument(asset: Asset): Promise<IndexedDocument> {
  const indexedAt = new Date().toISOString();

  if (asset.type === "pdf") {
    const start = Date.now();
    console.log(`  → extracting PDF: ${asset.title}`);
    const result = await extractPdf(asset.url);
    console.log(`    extracted ${result.pageCount} page(s), ${result.content.length} chars (${ms(start)})`);
    return {
      id: asset.id,
      data: {
        title: asset.title,
        asset_type: "pdf",
        source_url: asset.url,
        body: result.content,
        page_count: result.pageCount,
        indexed_at: indexedAt,
      },
    };
  }

  const start = Date.now();
  console.log(`  → analyzing image: ${asset.title}`);
  const result = await analyzeImage(asset.url);
  console.log(`    description: ${result.description.slice(0, 80)}... (${ms(start)})`);
  return {
    id: asset.id,
    data: {
      title: asset.title,
      asset_type: "image",
      source_url: asset.url,
      body: result.description,
      caption: result.caption,
      alt_text: result.altText,
      indexed_at: indexedAt,
    },
  };
}

async function main(): Promise<void> {
  requireEnv();

  const { assets } = loadManifest();
  console.log(`Loaded manifest: ${assets.length} assets\n`);

  console.log("Step 1/2: Extracting content");
  const documents: IndexedDocument[] = [];
  for (const asset of assets) {
    try {
      documents.push(await buildDocument(asset));
    } catch (err) {
      console.error(`    FAILED: ${asset.id} —`, err instanceof Error ? err.message : err);
    }
  }

  if (documents.length === 0) {
    throw new Error("No documents extracted; nothing to index.");
  }

  console.log(`\nStep 2/2: Indexing ${documents.length} document(s) via bulkIndex`);
  const start = Date.now();
  const result = await bulkIndex(documents);
  console.log(`  bulkIndex: code=${result.code} success=${result.success} (${ms(start)})`);
  for (const doc of result.documents) {
    console.log(`    indexed → ${doc.id}`);
  }

  console.log(`\nDone. ${documents.length}/${assets.length} assets indexed.`);
}

main().catch((err) => {
  console.error("[ingest] failed:", err);
  process.exit(1);
});
