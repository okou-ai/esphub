import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import { thumbnailWidths } from "../../../shared/board-photo.js";
import { mcpEndpoint } from "../../../shared/identity.js";
import { BoardPhoto, type BoardSpec } from "./components/board-photo";
import { agents, manufacturer } from "./components/landing-brands";
import logo from "./assets/esphub-logo-light.svg";
import "./boards-page.css";
import "./projects-page.css";

const PAGE_SIZE = 18;

const projectUuidPattern =
  /^\/projects\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

export function parseProjectsPath(pathname: string): string | null {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const match = projectUuidPattern.exec(clean);
  return match ? match[1].toLowerCase() : null;
}

type DirectoryBoard = {
  id: string;
  vendor: string;
  name: string;
  model: string;
  bootloader: string;
  spec: BoardSpec;
  product_url: string | null;
  image_url: string | null;
};

type ProjectBoardSummary = {
  board_id: string;
  version: string;
  sdk_version: string;
};

type ProjectAuthor = {
  id: string;
  name: string;
  logo_url: string | null;
  url: string | null;
};

type ProjectOwner = {
  name: string | null;
  avatar_url: string | null;
};

type PublicProjectSummary = {
  id: string;
  name: string;
  description: string;
  repo_url: string | null;
  repo_path: string | null;
  upstream_url?: string | null;
  tags?: string[];
  author?: ProjectAuthor | null;
  owner?: ProjectOwner | null;
  cover_image_url: string | null;
  boards: ProjectBoardSummary[];
};

type PublicProjectDetail = Omit<PublicProjectSummary, "boards"> & {
  images: { url: string | null }[];
  boards: {
    board_id: string;
    version: string;
    sdk_version: string;
    idf_version: string | null;
    source_revision: string | null;
  }[];
};

type FacetOption = {
  id: string;
  count: number;
};

type PaginatedProjectsResponse = {
  items: PublicProjectSummary[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  facets: {
    vendors: FacetOption[];
    socs: FacetOption[];
    tags?: FacetOption[];
  };
};

type SortKey = "recent" | "name" | "boards";

type ListParams = {
  page: number;
  q: string;
  vendor: string;
  soc: string;
  board: string;
  tag: string;
  sort: SortKey;
};

function formatSoc(soc: string): string {
  return soc.toUpperCase().replace(/^ESP32([A-Z])/, "ESP32-$1");
}

function formatPsram(psram: BoardSpec["psram"]): string {
  if (!psram) return "None";
  return psram === "octal" ? "Octal PSRAM" : "Quad PSRAM";
}

function projectSourceUrl(project: {
  repo_url: string | null;
  repo_path: string | null;
}): string | null {
  if (!project.repo_url) return null;
  if (!project.repo_path) return project.repo_url;
  return `${project.repo_url.replace(/\/$/, "")}/tree/main/${project.repo_path}`;
}

function shortRepoLabel(project: {
  repo_url: string | null;
  repo_path: string | null;
}): string {
  if (!project.repo_url) return "Published on EspHub";
  const repo = project.repo_url.replace(/^https:\/\/github\.com\//, "");
  return project.repo_path ? `${repo} · ${project.repo_path}` : repo;
}

function shortUpstreamLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const repo = `${parts[0]}/${parts[1]}`;
        if ((parts[2] === "blob" || parts[2] === "tree") && parts.length > 4) {
          return `${repo} · ${parts.slice(4).join("/")}`;
        }
        return repo;
      }
    }
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function resolveAuthorLogo(logoUrl: string | null): string | null {
  if (!logoUrl) return null;
  return logoUrl.replace(/^https:\/\/esphub\.ai(?=\/authors\/)/, "");
}

function AuthorBadge({ author }: { author: ProjectAuthor }) {
  const logoSrc = resolveAuthorLogo(author.logo_url);
  const content = (
    <>
      {logoSrc ? (
        <img
          className="pj-author-logo"
          src={logoSrc}
          alt={author.name}
          loading="lazy"
        />
      ) : (
        <span className="pj-author-name">{author.name}</span>
      )}
    </>
  );
  if (author.url) {
    return (
      <a
        className="pj-author-chip"
        href={author.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Author: ${author.name}`}
        aria-label={`Author: ${author.name}`}
      >
        {content}
      </a>
    );
  }
  return (
    <span className="pj-author-chip" title={`Author: ${author.name}`}>
      {content}
    </span>
  );
}

function OwnerBadge({ owner }: { owner: ProjectOwner }) {
  if (!owner.name) return null;
  const initial = owner.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="pj-owner-chip" title={owner.name}>
      {owner.avatar_url ? (
        <img
          className="pj-owner-avatar"
          src={owner.avatar_url}
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="pj-owner-initial" aria-hidden="true">
          {initial}
        </span>
      )}
      <span className="pj-owner-name">{owner.name}</span>
    </span>
  );
}

function ProjectAttribution({
  author,
  owner,
}: {
  author?: ProjectAuthor | null;
  owner?: ProjectOwner | null;
}) {
  if (author) return <AuthorBadge author={author} />;
  if (owner?.name) return <OwnerBadge owner={owner} />;
  return null;
}

function ProjectTagBadges({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null;
  const isFactory = tags.includes("factory");
  const isExample = tags.includes("example");
  if (!isFactory && !isExample) return null;
  return (
    <div className="pj-tag-badges">
      {isFactory && <span className="pj-tag-badge is-factory">Factory</span>}
      {isExample && <span className="pj-tag-badge is-example">Example</span>}
    </div>
  );
}

function ProjectPreviewImage({
  url,
  alt,
  sizes,
  loading = "lazy",
}: {
  url: string;
  alt: string;
  sizes: string;
  loading?: "lazy" | "eager";
}) {
  return (
    <img
      src={url}
      srcSet={thumbnailWidths.project
        .map((width) => `${url}?width=${width} ${width}w`)
        .join(", ")}
      sizes={sizes}
      alt={alt}
      loading={loading}
      decoding="async"
    />
  );
}

function parseListSearch(search: string): ListParams {
  const sp = new URLSearchParams(search);
  const rawPage = Number(sp.get("page") || "1");
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawSort = sp.get("sort");
  const sort: SortKey =
    rawSort === "name" || rawSort === "boards" ? rawSort : "recent";
  return {
    page,
    q: sp.get("q") ?? "",
    vendor: (sp.get("vendor") ?? "").trim().toLowerCase(),
    soc: (sp.get("soc") ?? "").trim().toLowerCase(),
    board: (sp.get("board") ?? "").trim().toLowerCase(),
    tag: (sp.get("tag") ?? "").trim().toLowerCase(),
    sort,
  };
}

function buildListUrl(params: ListParams): string {
  const sp = new URLSearchParams();
  if (params.page > 1) sp.set("page", String(params.page));
  if (params.q.trim()) sp.set("q", params.q.trim());
  if (params.vendor) sp.set("vendor", params.vendor);
  if (params.soc) sp.set("soc", params.soc);
  if (params.board) sp.set("board", params.board);
  if (params.tag) sp.set("tag", params.tag);
  if (params.sort !== "recent") sp.set("sort", params.sort);
  const qs = sp.toString();
  return qs ? `/projects?${qs}` : "/projects";
}

function buildApiUrl(params: ListParams): string {
  const sp = new URLSearchParams();
  sp.set("page", String(params.page));
  sp.set("limit", String(PAGE_SIZE));
  if (params.q.trim()) sp.set("q", params.q.trim());
  if (params.vendor) sp.set("vendor", params.vendor);
  if (params.soc) sp.set("soc", params.soc);
  if (params.board) sp.set("board", params.board);
  if (params.tag) {
    sp.set("tag", params.tag);
  } else {
    sp.set("exclude_tag", "example");
  }
  if (params.sort !== "recent") sp.set("sort", params.sort);
  return `/backend/projects?${sp.toString()}`;
}

function buildPageRange(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set<number>([1, total, current]);
  if (current > 1) pages.add(current - 1);
  if (current < total) pages.add(current + 1);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
  }
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const result: (number | "ellipsis")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push("ellipsis");
    result.push(sorted[i]);
  }
  return result;
}

type InstallModalState = {
  project: { id: string; name: string; boards: { board_id: string }[] };
  initialBoardId: string;
};

function ProjectInstallModal({
  modal,
  boardMap,
  onClose,
}: {
  modal: InstallModalState;
  boardMap: Map<string, DirectoryBoard>;
  onClose: () => void;
}) {
  const [selectedAgent, setSelectedAgent] = useState(agents[0].name);
  const [boardId, setBoardId] = useState(modal.initialBoardId);
  const [copied, setCopied] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const board = boardMap.get(boardId);
  const boardLabel = board ? `${board.model} (${boardId})` : boardId;
  const promptText = `Install "${modal.project.name}" on my ${boardLabel} over wireless OTA using EspHub MCP (${mcpEndpoint}).\n\n1. Check devices_list for my ${boardId} device (or guide me through first-time USB setup per https://esphub.ai/SKILL.md if not bound yet).\n2. Call projects_get with project_id="${modal.project.id}" to retrieve the release for ${boardId}.\n3. Enter Bootloader mode with bootloader_enter and verify online=true and info.role=bootloader via devices_get.\n4. Call ota_install with kind="app" using the returned release URL for ${boardId}, follow commands_get, and confirm the running firmware after reboot.`;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      fieldRef.current?.focus();
      fieldRef.current?.select();
    }
  }

  return (
    <div
      className="bh-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="proj-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bh-modal">
        <div className="bh-modal-top">
          <div>
            <p className="bh-modal-eyebrow">Wireless OTA · {boardId}</p>
            <h2 id="proj-modal-title" className="bh-modal-title">
              Install {modal.project.name}
            </h2>
          </div>
          <button
            type="button"
            className="bh-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        {modal.project.boards.length > 1 && (
          <div className="pj-modal-boards">
            <span className="pj-modal-boards-label">Target board</span>
            <div className="pj-modal-board-list">
              {modal.project.boards.map((b) => {
                const info = boardMap.get(b.board_id);
                return (
                  <button
                    key={b.board_id}
                    type="button"
                    className={`pj-modal-board-btn${boardId === b.board_id ? " is-selected" : ""}`}
                    onClick={() => {
                      setBoardId(b.board_id);
                      setCopied(false);
                    }}
                  >
                    {info ? `${manufacturer(info.id)} ${info.name}` : b.board_id}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="bh-modal-agents">
          {agents.slice(0, 4).map((a) => (
            <button
              key={a.name}
              type="button"
              className={`bh-modal-agent-btn${selectedAgent === a.name ? " is-selected" : ""}`}
              onClick={() => setSelectedAgent(a.name)}
            >
              <img src={a.logo} alt="" />
              <span>{a.name}</span>
            </button>
          ))}
        </div>

        <p style={{ fontSize: 13.5, color: "#4d5744", marginBottom: 10 }}>
          Paste this prompt into <strong>{selectedAgent}</strong> to run it via
          EspHub MCP:
        </p>

        <textarea
          ref={fieldRef}
          className="bh-modal-textarea"
          aria-label="Agent prompt"
          readOnly
          value={promptText}
        />

        <button type="button" className="bh-modal-copy-btn" onClick={copy}>
          <span>{copied ? "Copied" : `Copy prompt for ${selectedAgent}`}</span>
          {copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
        </button>
      </div>
    </div>
  );
}

function ProjectDetailView({
  projectId,
  boardMap,
  onBackToList,
  onOpenInstall,
}: {
  projectId: string;
  boardMap: Map<string, DirectoryBoard>;
  onBackToList: () => void;
  onOpenInstall: (modal: InstallModalState) => void;
}) {
  const [project, setProject] = useState<PublicProjectDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    let active = true;
    setProject(null);
    setNotFound(false);
    setFailed(false);
    fetch(`/backend/projects/${projectId}`)
      .then(async (r) => {
        if (r.status === 404) {
          if (active) setNotFound(true);
          return null;
        }
        if (!r.ok) throw Error("Failed to load project");
        return (await r.json()) as PublicProjectDetail;
      })
      .then((data) => {
        if (active && data) setProject(data);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    document.title = project
      ? `${project.name} — EspHub Projects`
      : "Projects — EspHub";
  }, [project]);

  function handleBackLink(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onBackToList();
  }

  if (failed) {
    return (
      <main className="bh-detail-shell">
        <div className="bh-empty">
          <h3>Project unavailable</h3>
          <p>Could not load project details right now.</p>
        </div>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="bh-detail-shell">
        <div className="bh-empty">
          <h3>Project not found</h3>
          <p>No published project matches this link.</p>
          <div style={{ marginTop: 18 }}>
            <a
              className="bh-btn-primary"
              href="/projects"
              onClick={handleBackLink}
            >
              Browse all projects
            </a>
          </div>
        </div>
      </main>
    );
  }

  if (!project) {
    return (
      <main className="bh-detail-shell">
        <div className="bh-empty">
          <p role="status">Loading project…</p>
        </div>
      </main>
    );
  }

  const source = projectSourceUrl(project);
  const defaultBoardId = project.boards[0]?.board_id ?? "";
  const images = [
    ...new Set(project.images.flatMap(({ url }) => (url ? [url] : []))),
  ];
  const cover = project.cover_image_url ?? images[0];
  const screenshots = images.filter((url) => url !== cover);

  return (
    <main className="bh-detail-shell">
      <nav className="bh-breadcrumb-bar" aria-label="Breadcrumb">
        <div className="bh-breadcrumb">
          <a
            className="bh-crumb-link"
            href="/projects"
            onClick={handleBackLink}
          >
            Projects
          </a>
          <span className="bh-crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="bh-crumb-current" aria-current="page">
            {project.name}
          </span>
        </div>
      </nav>

      <section
        className={`pj-detail-header${cover ? " has-cover" : ""}`}
        aria-labelledby="project-detail-title"
      >
        <div className="pj-detail-main">
          {Boolean(project.author || project.owner?.name || project.tags?.length) && (
            <div className="pj-detail-meta">
              <ProjectTagBadges tags={project.tags} />
              <ProjectAttribution author={project.author} owner={project.owner} />
            </div>
          )}

          <h1 id="project-detail-title" className="bh-detail-title">
            {project.name}
          </h1>

          {project.upstream_url && (
            <p className="pj-upstream-line">
              Adapted from{" "}
              <a
                href={project.upstream_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortUpstreamLabel(project.upstream_url)}{" "}
                <ArrowUpRightIcon size={12} aria-hidden="true" />
              </a>
            </p>
          )}

          <p className="pj-detail-desc">
            {project.description || "Published ESP32 application for EspHub OTA."}
          </p>

          {source && (
            <div className="pj-detail-source-row">
              <a href={source} target="_blank" rel="noopener noreferrer">
                <GitBranchIcon size={14} aria-hidden="true" />
                <span>{shortRepoLabel(project)}</span>
                <ArrowUpRightIcon size={13} aria-hidden="true" />
              </a>
            </div>
          )}

          <div className="pj-detail-actions">
            {defaultBoardId && (
              <button
                type="button"
                className="bh-btn-primary"
                onClick={() =>
                  onOpenInstall({
                    project,
                    initialBoardId: defaultBoardId,
                  })
                }
              >
                <TerminalWindowIcon size={16} aria-hidden="true" />
                Install via Agent <ArrowRightIcon size={15} aria-hidden="true" />
              </button>
            )}
            {source && (
              <a
                className="bh-btn-secondary"
                href={source}
                target="_blank"
                rel="noopener noreferrer"
              >
                View source <ArrowUpRightIcon size={15} aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        {cover && (
          <a
            className="pj-detail-cover pj-image-frame"
            href={cover}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ProjectPreviewImage
              url={cover}
              alt={`${project.name} cover image`}
              sizes="(max-width: 760px) 85vw, (max-width: 1480px) 35vw, 500px"
              loading="eager"
            />
          </a>
        )}
      </section>

      {screenshots.length > 0 && (
        <section
          className="bh-projects-section"
          aria-labelledby="project-gallery-heading"
        >
          <div className="bh-section-head">
            <h2 id="project-gallery-heading" className="bh-section-title">
              Gallery
            </h2>
          </div>
          <div className="pj-gallery-grid">
            {screenshots.map((url, index) => (
              <a
                key={url}
                className="pj-image-frame"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ProjectPreviewImage
                  url={url}
                  alt={`${project.name} gallery image ${index + 1}`}
                  sizes="(max-width: 400px) 45vw, 220px"
                />
              </a>
            ))}
          </div>
        </section>
      )}

      <section
        className="bh-projects-section"
        aria-labelledby="supported-boards-heading"
      >
        <div className="bh-section-head">
          <h2 id="supported-boards-heading" className="bh-section-title">
            Supported Boards
            <span className="bh-count-badge">{project.boards.length}</span>
          </h2>
        </div>

        <div className="pj-boards-grid">
          {project.boards.map((ref) => {
            const board = boardMap.get(ref.board_id);
            return (
              <article className="pj-board-card" key={ref.board_id}>
                <a className="pj-board-link" href={`/boards/${ref.board_id}`}>
                  <div className="bh-card-plate">
                    <span className="bh-card-vendor">
                      {manufacturer(ref.board_id)}
                    </span>
                    <BoardPhoto
                      imageUrl={board?.image_url ?? undefined}
                      size="wall"
                      alt={board?.model ?? ref.board_id}
                      className="bh-card-photo"
                    />
                  </div>
                  <div className="bh-card-body">
                    <div className="bh-card-head">
                      <span className="bh-card-name">
                        {board?.name ?? ref.board_id}
                      </span>
                      <ArrowRightIcon
                        size={15}
                        className="bh-card-arrow"
                        aria-hidden="true"
                      />
                    </div>
                    {board && (
                      <div className="bh-spec-pills">
                        <span className="bh-spec-pill is-soc">
                          {formatSoc(board.spec.soc)}
                        </span>
                        <span className="bh-spec-pill">
                          {board.spec.flash_mb} MB
                        </span>
                        {board.spec.psram && (
                          <span className="bh-spec-pill">
                            {formatPsram(board.spec.psram)}
                          </span>
                        )}
                      </div>
                    )}
                    <span className="bh-card-id">{ref.board_id}</span>
                  </div>
                </a>
                <div className="bh-proj-actions">
                  <button
                    type="button"
                    className="bh-proj-ota-btn"
                    onClick={() =>
                      onOpenInstall({
                        project,
                        initialBoardId: ref.board_id,
                      })
                    }
                  >
                    <TerminalWindowIcon size={14} aria-hidden="true" />
                    Install via Agent
                  </button>
                  <a
                    className="bh-proj-mini-btn"
                    href={`/boards/${ref.board_id}`}
                  >
                    Spec <ArrowRightIcon size={13} aria-hidden="true" />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

export default function ProjectsPage({
  initialProjectId,
}: {
  initialProjectId: string | null;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId,
  );
  const [params, setParams] = useState<ListParams>(() =>
    parseListSearch(location.search),
  );
  const [searchInput, setSearchInput] = useState(() =>
    parseListSearch(location.search).q,
  );
  const [pageData, setPageData] = useState<PaginatedProjectsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(!initialProjectId);
  const [failed, setFailed] = useState(false);
  const [boards, setBoards] = useState<DirectoryBoard[]>([]);
  const [modal, setModal] = useState<InstallModalState | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/backend/boards")
      .then((r) => (r.ok ? (r.json() as Promise<DirectoryBoard[]>) : []))
      .then((list) => {
        if (active) setBoards(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const boardMap = useMemo(
    () => new Map(boards.map((b) => [b.id, b])),
    [boards],
  );

  // Sync debounced search input into URL + backend query
  useEffect(() => {
    if (selectedProjectId) return;
    if (searchInput.trim() === params.q.trim()) return;
    const timer = setTimeout(() => {
      updateListParams({ q: searchInput.trim(), page: 1 }, { replace: true });
    }, 220);
    return () => clearTimeout(timer);
  }, [searchInput, selectedProjectId, params.q]);

  // Fetch paginated projects from backend whenever list params change
  useEffect(() => {
    if (selectedProjectId) return;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    fetch(buildApiUrl(params), { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw Error("Failed to load projects");
        return r.json() as Promise<PaginatedProjectsResponse>;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setPageData(data);
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [selectedProjectId, params]);

  useEffect(() => {
    const onPop = () => {
      const nextId = parseProjectsPath(location.pathname);
      setSelectedProjectId(nextId);
      if (!nextId) {
        const nextParams = parseListSearch(location.search);
        setParams(nextParams);
        setSearchInput(nextParams.q);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!selectedProjectId) document.title = "Projects — EspHub";
  }, [selectedProjectId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key === "/" &&
        !selectedProjectId &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedProjectId]);

  function updateListParams(
    patch: Partial<ListParams>,
    { replace = false, scrollTop = false } = {},
  ) {
    setParams((prev) => {
      const next: ListParams = { ...prev, ...patch };
      const nextUrl = buildListUrl(next);
      if (`${location.pathname}${location.search}` !== nextUrl) {
        if (replace) history.replaceState(null, "", nextUrl);
        else history.pushState(null, "", nextUrl);
      }
      return next;
    });
    if (scrollTop) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function navigateProject(id: string | null, { reset = false } = {}) {
    if (id) {
      const nextUrl = `/projects/${id}`;
      if (location.pathname !== nextUrl) history.pushState(null, "", nextUrl);
      setSelectedProjectId(id);
      return;
    }
    if (reset) {
      const clean: ListParams = {
        page: 1,
        q: "",
        vendor: "",
        soc: "",
        board: "",
        tag: "",
        sort: "recent",
      };
      setParams(clean);
      setSearchInput("");
      if (`${location.pathname}${location.search}` !== "/projects") {
        history.pushState(null, "", "/projects");
      }
    } else {
      const listUrl = buildListUrl(params);
      if (`${location.pathname}${location.search}` !== listUrl) {
        history.pushState(null, "", listUrl);
      }
    }
    setSelectedProjectId(null);
  }

  function clearAll() {
    setSearchInput("");
    updateListParams({
      page: 1,
      q: "",
      vendor: "",
      soc: "",
      board: "",
      tag: "",
    });
  }

  function onProjectLinkClick(e: MouseEvent<HTMLAnchorElement>, id: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigateProject(id);
  }

  const hasFilters = Boolean(
    params.q.trim() || params.vendor || params.soc || params.board || params.tag,
  );
  const items = pageData?.items ?? [];
  const total = pageData?.total ?? 0;
  const totalPages = pageData?.total_pages ?? 0;
  const currentPage = pageData?.page ?? params.page;
  const startIdx = total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const endIdx = Math.min(currentPage * PAGE_SIZE, total);
  const vendorFacets = pageData?.facets.vendors ?? [];
  const socFacets = pageData?.facets.socs ?? [];
  const tagFacetsMap = useMemo(
    () => new Map((pageData?.facets.tags ?? []).map((t) => [t.id, t.count])),
    [pageData?.facets.tags],
  );
  const factoryCount = tagFacetsMap.get("factory") ?? 0;
  const exampleCount = tagFacetsMap.get("example") ?? 0;

  return (
    <div className="esphub-boards-app">
      <header className="bh-masthead">
        <div className="bh-masthead-inner">
          <div className="bh-brand-group">
            <a className="bh-logo" href="/" aria-label="EspHub home">
              <img src={logo} alt="EspHub" width={109} height={31} />
            </a>
            <nav className="bh-nav" aria-label="Primary">
              <a className="bh-nav-link" href="/">
                Home
              </a>
              <a className="bh-nav-link" href="/boards">
                Boards
              </a>
              <a
                className="bh-nav-link is-active"
                href="/projects"
                aria-current="page"
                onClick={(e) => {
                  if (
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey ||
                    e.button !== 0
                  )
                    return;
                  e.preventDefault();
                  navigateProject(null, { reset: true });
                }}
              >
                Projects
              </a>
            </nav>
          </div>
          <a className="bh-workspace-link" href="/devices">
            Open workspace <ArrowUpRightIcon size={14} aria-hidden="true" />
          </a>
        </div>
      </header>

      {selectedProjectId ? (
        <ProjectDetailView
          projectId={selectedProjectId}
          boardMap={boardMap}
          onBackToList={() => navigateProject(null)}
          onOpenInstall={setModal}
        />
      ) : (
        <>
          <section className="bh-dir-hero">
            <div className="bh-dir-hero-inner">
              <h1 className="bh-dir-title">
                Runnable <em>ESP32</em> Projects.
              </h1>
            </div>
          </section>

          <section className="bh-workbench" aria-label="Project filters">
            <div className="bh-workbench-inner">
              <div className="bh-toolbar-row">
                <div className="bh-search-wrap">
                  <MagnifyingGlassIcon
                    size={16}
                    className="bh-search-icon"
                    aria-hidden="true"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    className="bh-search-input"
                    placeholder="Search project name, description, board, or SoC…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    aria-label="Search projects"
                  />
                  {searchInput ? (
                    <button
                      type="button"
                      className="bh-search-clear"
                      onClick={() => {
                        setSearchInput("");
                        updateListParams({ q: "", page: 1 });
                      }}
                      aria-label="Clear search"
                    >
                      <XIcon size={14} />
                    </button>
                  ) : (
                    <span className="bh-search-kbd" aria-hidden="true">
                      /
                    </span>
                  )}
                </div>

                <div className="bh-toolbar-actions">
                  <select
                    className="bh-select"
                    aria-label="Sort projects"
                    value={params.sort}
                    onChange={(e) =>
                      updateListParams({
                        sort: e.target.value as SortKey,
                        page: 1,
                      })
                    }
                  >
                    <option value="recent">Sort: Latest</option>
                    <option value="name">Sort: Name A → Z</option>
                    <option value="boards">Sort: Most boards</option>
                  </select>
                </div>
              </div>

              <div className="bh-facets">
                <div
                  className="bh-facet-group"
                  role="group"
                  aria-label="Filter by tag"
                >
                  <span className="bh-facet-label">Tag</span>
                  <button
                    type="button"
                    className={`bh-chip${!params.tag ? " is-active" : ""}`}
                    onClick={() => updateListParams({ tag: "", page: 1 })}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`bh-chip${params.tag === "factory" ? " is-active" : ""}${factoryCount === 0 && params.tag !== "factory" ? " is-zero" : ""}`}
                    onClick={() =>
                      updateListParams({
                        tag: params.tag === "factory" ? "" : "factory",
                        page: 1,
                      })
                    }
                  >
                    Factory
                    {factoryCount > 0 && (
                      <span className="bh-chip-count">{factoryCount}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`bh-chip${params.tag === "example" ? " is-active" : ""}${exampleCount === 0 && params.tag !== "example" ? " is-zero" : ""}`}
                    onClick={() =>
                      updateListParams({
                        tag: params.tag === "example" ? "" : "example",
                        page: 1,
                      })
                    }
                  >
                    Examples
                    {exampleCount > 0 && (
                      <span className="bh-chip-count">{exampleCount}</span>
                    )}
                  </button>
                </div>

                {vendorFacets.length > 0 && (
                  <div
                    className="bh-facet-group"
                    role="group"
                    aria-label="Filter by vendor"
                  >
                    <span className="bh-facet-label">Vendor</span>
                    <button
                      type="button"
                      className={`bh-chip${!params.vendor ? " is-active" : ""}`}
                      onClick={() =>
                        updateListParams({ vendor: "", page: 1 })
                      }
                    >
                      All
                    </button>
                    {vendorFacets.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`bh-chip${params.vendor === opt.id ? " is-active" : ""}`}
                        onClick={() =>
                          updateListParams({
                            vendor: params.vendor === opt.id ? "" : opt.id,
                            page: 1,
                          })
                        }
                      >
                        {manufacturer(`${opt.id}/x`)}
                        <span className="bh-chip-count">{opt.count}</span>
                      </button>
                    ))}
                  </div>
                )}

                {socFacets.length > 0 && (
                  <div
                    className="bh-facet-group"
                    role="group"
                    aria-label="Filter by SoC"
                  >
                    <span className="bh-facet-label">SoC</span>
                    <button
                      type="button"
                      className={`bh-chip${!params.soc ? " is-active" : ""}`}
                      onClick={() => updateListParams({ soc: "", page: 1 })}
                    >
                      All
                    </button>
                    {socFacets.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`bh-chip${params.soc === opt.id ? " is-active" : ""}`}
                        onClick={() =>
                          updateListParams({
                            soc: params.soc === opt.id ? "" : opt.id,
                            page: 1,
                          })
                        }
                      >
                        {formatSoc(opt.id)}
                        <span className="bh-chip-count">{opt.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          <main className="bh-main">
            {failed ? (
              <div className="bh-empty">
                <h3>Projects directory unavailable</h3>
                <p>Could not load projects from EspHub right now.</p>
              </div>
            ) : loading && !pageData ? (
              <div className="bh-empty">
                <p role="status">Loading projects…</p>
              </div>
            ) : (
              <>
                <div className="bh-results-bar">
                  <p className="bh-results-count">
                    {total === 0 ? (
                      <>
                        Showing <strong>0</strong> projects
                      </>
                    ) : (
                      <>
                        Showing{" "}
                        <strong>
                          {startIdx}–{endIdx}
                        </strong>{" "}
                        of {total} projects
                      </>
                    )}
                  </p>

                  {hasFilters && (
                    <div className="bh-active-tags">
                      {params.tag && (
                        <button
                          type="button"
                          className="bh-active-tag"
                          onClick={() => updateListParams({ tag: "", page: 1 })}
                        >
                          {params.tag === "factory"
                            ? "Factory"
                            : params.tag === "example"
                              ? "Examples"
                              : params.tag}{" "}
                          <XIcon size={11} />
                        </button>
                      )}
                      {params.vendor && (
                        <button
                          type="button"
                          className="bh-active-tag"
                          onClick={() =>
                            updateListParams({ vendor: "", page: 1 })
                          }
                        >
                          {manufacturer(`${params.vendor}/x`)}{" "}
                          <XIcon size={11} />
                        </button>
                      )}
                      {params.soc && (
                        <button
                          type="button"
                          className="bh-active-tag"
                          onClick={() => updateListParams({ soc: "", page: 1 })}
                        >
                          {formatSoc(params.soc)} <XIcon size={11} />
                        </button>
                      )}
                      {params.board && (
                        <button
                          type="button"
                          className="bh-active-tag"
                          onClick={() =>
                            updateListParams({ board: "", page: 1 })
                          }
                        >
                          {boardMap.get(params.board)?.name ?? params.board}{" "}
                          <XIcon size={11} />
                        </button>
                      )}
                      {params.q.trim() && (
                        <button
                          type="button"
                          className="bh-active-tag"
                          onClick={() => {
                            setSearchInput("");
                            updateListParams({ q: "", page: 1 });
                          }}
                        >
                          “{params.q.trim()}” <XIcon size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="bh-clear-all"
                        onClick={clearAll}
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                </div>

                {items.length === 0 ? (
                  <div className="bh-empty">
                    <h3>No projects match the current filters</h3>
                    <p>
                      Try clearing a Vendor, SoC, or keyword filter, or return
                      to page 1.
                    </p>
                    <div style={{ marginTop: 18 }}>
                      <button
                        type="button"
                        className="bh-btn-primary"
                        onClick={clearAll}
                      >
                        Reset filters
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className={`pj-grid${loading ? " is-loading" : ""}`}
                    aria-busy={loading}
                  >
                    {items.map((project) => {
                      const source = projectSourceUrl(project);
                      const visibleBoards = project.boards.slice(0, 3);
                      const extraBoards =
                        project.boards.length - visibleBoards.length;
                      const firstBoardId = project.boards[0]?.board_id ?? "";
                      return (
                        <article className="pj-card" key={project.id}>
                          {Boolean(project.author || project.owner?.name || project.tags?.length) && (
                            <div className="pj-card-meta">
                              <ProjectTagBadges tags={project.tags} />
                              <ProjectAttribution
                                author={project.author}
                                owner={project.owner}
                              />
                            </div>
                          )}
                          <a
                            className="pj-card-link"
                            href={`/projects/${project.id}`}
                            onClick={(e) => onProjectLinkClick(e, project.id)}
                          >
                            {project.cover_image_url && (
                              <div className="pj-image-frame">
                                <ProjectPreviewImage
                                  url={project.cover_image_url}
                                  alt=""
                                  sizes="(max-width: 680px) 85vw, (max-width: 1080px) 42vw, (max-width: 1480px) 28vw, 420px"
                                />
                              </div>
                            )}
                            <div className="pj-card-head">
                              <h2 className="pj-card-name">{project.name}</h2>
                              <ArrowRightIcon
                                size={15}
                                className="pj-card-arrow"
                                aria-hidden="true"
                              />
                            </div>
                            {project.upstream_url && (
                              <span className="pj-card-upstream">
                                Adapted from {shortUpstreamLabel(project.upstream_url)}
                              </span>
                            )}
                            <p className="pj-card-desc">
                              {project.description ||
                                "Published ESP32 application for EspHub OTA."}
                            </p>
                          </a>

                          <div className="pj-card-boards">
                            {visibleBoards.map((b) => {
                              const info = boardMap.get(b.board_id);
                              return (
                                <a
                                  key={b.board_id}
                                  className="pj-board-pill"
                                  href={`/boards/${b.board_id}`}
                                  title={info?.model ?? b.board_id}
                                >
                                  <span className="pj-board-pill-vendor">
                                    {manufacturer(b.board_id)}
                                  </span>
                                  <span>{info?.name ?? b.board_id.split("/")[1]}</span>
                                </a>
                              );
                            })}
                            {extraBoards > 0 && (
                              <a
                                className="pj-board-pill is-more"
                                href={`/projects/${project.id}`}
                                onClick={(e) =>
                                  onProjectLinkClick(e, project.id)
                                }
                              >
                                +{extraBoards} more
                              </a>
                            )}
                          </div>

                          <div className="bh-proj-actions">
                            {firstBoardId && (
                              <button
                                type="button"
                                className="bh-proj-ota-btn"
                                onClick={() =>
                                  setModal({
                                    project,
                                    initialBoardId: firstBoardId,
                                  })
                                }
                              >
                                <TerminalWindowIcon
                                  size={14}
                                  aria-hidden="true"
                                />
                                Install via Agent
                              </button>
                            )}
                            {source && (
                              <a
                                className="bh-proj-mini-btn"
                                href={source}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Source{" "}
                                <ArrowUpRightIcon
                                  size={13}
                                  aria-hidden="true"
                                />
                              </a>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}

                {totalPages > 1 && (
                  <nav
                    className="pj-pagination"
                    aria-label="Projects pagination"
                  >
                    <button
                      type="button"
                      className="pj-page-btn"
                      disabled={currentPage <= 1}
                      onClick={() =>
                        updateListParams(
                          { page: currentPage - 1 },
                          { scrollTop: true },
                        )
                      }
                    >
                      <ArrowLeftIcon size={13} aria-hidden="true" /> Prev
                    </button>

                    <div className="pj-page-numbers">
                      {buildPageRange(currentPage, totalPages).map((entry, idx) =>
                        entry === "ellipsis" ? (
                          <span
                            key={`e-${idx}`}
                            className="pj-page-ellipsis"
                            aria-hidden="true"
                          >
                            …
                          </span>
                        ) : (
                          <button
                            key={entry}
                            type="button"
                            className={`pj-page-btn${entry === currentPage ? " is-active" : ""}`}
                            aria-current={
                              entry === currentPage ? "page" : undefined
                            }
                            onClick={() =>
                              updateListParams(
                                { page: entry },
                                { scrollTop: true },
                              )
                            }
                          >
                            {entry}
                          </button>
                        ),
                      )}
                    </div>

                    <button
                      type="button"
                      className="pj-page-btn"
                      disabled={currentPage >= totalPages}
                      onClick={() =>
                        updateListParams(
                          { page: currentPage + 1 },
                          { scrollTop: true },
                        )
                      }
                    >
                      Next <ArrowRightIcon size={13} aria-hidden="true" />
                    </button>
                  </nav>
                )}
              </>
            )}
          </main>
        </>
      )}

      <footer className="bh-footer">
        <div className="bh-footer-inner">
          <nav aria-label="Legal">
            <a href="/terms/">Terms of Service</a>
            <a href="/privacy/">Privacy Policy</a>
          </nav>
        </div>
      </footer>

      {modal && (
        <ProjectInstallModal
          modal={modal}
          boardMap={boardMap}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
