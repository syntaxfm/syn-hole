import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import NumberFlow from "@number-flow/react";
import {
  Copy,
  CheckCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Users,
  Link2,
  QrCode,
  Eye,
  EyeOff,
  Shield,
  ListChecks,
} from "lucide-react";
import { adminFetch, readAdminKey, saveAdminKey } from "~/utils/admin-api";

type RoomEntry = {
  name: string;
  host_key: string;
  created_at: string;
  start_at: string | null;
};

type RoomStats = {
  room: string;
  currentQuestionIndex: number;
  totalQuestions: number;
  participants: number;
  audienceCount: number;
  hostCount: number;
  projectorCount: number;
  questions: Array<{
    index: number;
    id: string;
    prompt: string;
    phase: string;
    totalVotes: number;
  }>;
};

function toDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function dateTimeLocalToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function getDefaultStartAtInput(): string {
  const defaultDate = new Date(Date.now() + 5 * 60_000);
  defaultDate.setSeconds(0, 0);
  return toDateTimeLocalValue(defaultDate.toISOString());
}

function formatRoomStartAt(value: string | null): string {
  if (!value) return "No start time set";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Invalid start time";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AdminPage() {
  const [adminKey, setAdminKey] = useState(() => readAdminKey());
  const [authenticated, setAuthenticated] = useState(false);
  const [rooms, setRooms] = useState<RoomEntry[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, RoomStats>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomHostKey, setNewRoomHostKey] = useState("");
  const [newRoomStartAt, setNewRoomStartAt] = useState(() => getDefaultStartAtInput());
  const [creating, setCreating] = useState(false);

  const [expandedRoom, setExpandedRoom] = useState<string | null>(null);
  const [showQr, setShowQr] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [showHostKeys, setShowHostKeys] = useState<Record<string, boolean>>({});
  const [roomStartAtDrafts, setRoomStartAtDrafts] = useState<Record<string, string>>({});
  const [updatingRoomStartAt, setUpdatingRoomStartAt] = useState<Record<string, boolean>>({});
  const [recentlyUpdatedRoomStartAt, setRecentlyUpdatedRoomStartAt] = useState<string | null>(null);

  const fetchRooms = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await adminFetch("/api/admin/rooms", adminKey);
      if (!resp.ok) {
        if (resp.status === 401) {
          setAuthenticated(false);
          setError("Invalid admin key.");
          setLoading(false);
          return;
        }
        throw new Error(`${resp.status} ${resp.statusText}`);
      }
      const data = (await resp.json()) as RoomEntry[];
      setRooms(data);
      setAuthenticated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch rooms");
    }
    setLoading(false);
  }, [adminKey]);

  const fetchStats = useCallback(
    async (roomName: string) => {
      try {
        const resp = await adminFetch(
          `/api/admin/rooms/${encodeURIComponent(roomName)}/stats`,
          adminKey
        );
        if (resp.ok) {
          const data = (await resp.json()) as RoomStats;
          setStatsMap((prev) => ({ ...prev, [roomName]: data }));
        }
      } catch {
        // Stats fetch failure is non-critical
      }
    },
    [adminKey]
  );

  useEffect(() => {
    if (adminKey.trim()) {
      void fetchRooms();
    }
  }, []);

  useEffect(() => {
    if (!authenticated || rooms.length === 0) return;
    for (const room of rooms) {
      void fetchStats(room.name);
    }
    const interval = setInterval(() => {
      for (const room of rooms) {
        void fetchStats(room.name);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [authenticated, rooms, fetchStats]);

  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    for (const room of rooms) {
      const fromStartAt = room.start_at ? toDateTimeLocalValue(room.start_at) : "";
      const fromCreatedAt = room.created_at ? toDateTimeLocalValue(room.created_at) : "";
      nextDrafts[room.name] = fromStartAt || fromCreatedAt || getDefaultStartAtInput();
    }
    setRoomStartAtDrafts(nextDrafts);
  }, [rooms]);

  function handleLogin(e: FormEvent) {
    e.preventDefault();
    saveAdminKey(adminKey.trim());
    void fetchRooms();
  }

  async function handleCreateRoom(e: FormEvent) {
    e.preventDefault();
    if (!newRoomName.trim() || !newRoomHostKey.trim()) return;
    const startAtIso = dateTimeLocalToIso(newRoomStartAt);
    if (!startAtIso) {
      setError("Please enter a valid room start time.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const resp = await adminFetch("/api/admin/rooms", adminKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: newRoomName.trim(),
          hostKey: newRoomHostKey.trim(),
          startAt: startAtIso,
        }),
      });
      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to create room");
      }
      setNewRoomName("");
      setNewRoomHostKey("");
      setNewRoomStartAt(getDefaultStartAtInput());
      await fetchRooms();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create room");
    }
    setCreating(false);
  }

  async function handleDeleteRoom(roomName: string) {
    if (!confirm(`Delete room "${roomName}"? This removes the room configuration but not its data.`)) {
      return;
    }
    try {
      await adminFetch(`/api/admin/rooms/${encodeURIComponent(roomName)}`, adminKey, {
        method: "DELETE",
      });
      await fetchRooms();
    } catch {
      setError("Failed to delete room");
    }
  }

  async function handleResetRoom(roomName: string) {
    if (!confirm(`Reset room "${roomName}"? This clears all votes, phases, and resets to question 1.`)) {
      return;
    }
    try {
      const resp = await adminFetch(
        `/api/admin/rooms/${encodeURIComponent(roomName)}/reset`,
        adminKey,
        { method: "POST" }
      );
      if (resp.ok) {
        await fetchStats(roomName);
      }
    } catch {
      setError("Failed to reset room");
    }
  }

  async function handleUpdateRoomStartAt(room: RoomEntry) {
    const nextStartAtInput = roomStartAtDrafts[room.name] ?? "";
    const startAtIso = dateTimeLocalToIso(nextStartAtInput);
    if (!startAtIso) {
      setError(`Please enter a valid open time for "${room.name}".`);
      return;
    }

    setError(null);
    setUpdatingRoomStartAt((prev) => ({ ...prev, [room.name]: true }));
    try {
      const resp = await adminFetch("/api/admin/rooms", adminKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: room.name,
          hostKey: room.host_key,
          startAt: startAtIso,
        }),
      });
      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to update room open time");
      }
      await fetchRooms();
      setRecentlyUpdatedRoomStartAt(room.name);
      window.setTimeout(() => {
        setRecentlyUpdatedRoomStartAt((current) => (current === room.name ? null : current));
      }, 1400);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update room open time");
    } finally {
      setUpdatingRoomStartAt((prev) => ({ ...prev, [room.name]: false }));
    }
  }

  function copyLink(label: string, url: string) {
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedLink(label);
      setTimeout(() => setCopiedLink((c) => (c === label ? null : c)), 1200);
    });
  }

  function getRoomUrls(roomName: string, hostKey: string) {
    if (typeof window === "undefined") return { audience: "", projector: "", host: "" };
    const base = window.location.origin;
    const roomPath = `/r/${encodeURIComponent(roomName)}`;
    const hostUrl = new URL(`${roomPath}/host`, base);
    if (hostKey) hostUrl.searchParams.set("hostKey", hostKey);
    return {
      audience: `${base}${roomPath}`,
      projector: `${base}${roomPath}/screen`,
      host: hostUrl.toString(),
    };
  }

  if (!authenticated) {
    return (
      <main className="app admin-app">
        <div className="admin-login-wrap">
          <form className="admin-login-card" onSubmit={handleLogin}>
            <div className="admin-login-icon">
              <Shield size={32} strokeWidth={1.5} />
            </div>
            <h2>Admin Access</h2>
            <p className="muted">Enter your admin key to manage rooms.</p>
            <input
              className="text-input"
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.currentTarget.value)}
              placeholder="Admin key"
              autoFocus
            />
            {error ? <p className="error">{error}</p> : null}
            <button type="submit" disabled={!adminKey.trim()}>
              Authenticate
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="app admin-app">
      <header className="admin-header">
        <div>
          <h1>Room Admin</h1>
          <p className="muted">Create and manage poll rooms</p>
        </div>
        <button
          type="button"
          className="admin-refresh-btn"
          onClick={() => fetchRooms()}
          disabled={loading}
        >
          <RefreshCw size={14} strokeWidth={2} className={loading ? "spin" : ""} />
          Refresh
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="panel admin-create-card">
        <h3>
          <Plus size={18} strokeWidth={2} /> Create Room
        </h3>
        <form className="admin-create-form" onSubmit={handleCreateRoom}>
          <div className="admin-create-fields">
            <label className="admin-field-label">
              Room Name
              <input
                className="text-input"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.currentTarget.value)}
                placeholder="e.g. main-stage"
              />
            </label>
            <label className="admin-field-label">
              Host Key
              <input
                className="text-input"
                value={newRoomHostKey}
                onChange={(e) => setNewRoomHostKey(e.currentTarget.value)}
                placeholder="Secret host key for this room"
              />
            </label>
            <label className="admin-field-label">
              Start Time
              <input
                className="text-input"
                type="datetime-local"
                value={newRoomStartAt}
                onChange={(e) => setNewRoomStartAt(e.currentTarget.value)}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={
              creating || !newRoomName.trim() || !newRoomHostKey.trim() || !newRoomStartAt.trim()
            }
          >
            {creating ? "Creating..." : "Create Room"}
          </button>
        </form>
      </section>

      <section className="admin-rooms-section">
        <h3>
          Rooms (<FlowInteger value={rooms.length} />)
        </h3>
        {rooms.length === 0 ? (
          <p className="muted">No rooms yet. Create one above.</p>
        ) : (
          <div className="admin-rooms-grid">
            {rooms.map((room) => {
              const stats = statsMap[room.name];
              const urls = getRoomUrls(room.name, room.host_key);
              const isExpanded = expandedRoom === room.name;
              const isQrVisible = showQr === room.name;
              const isHostKeyVisible = showHostKeys[room.name] ?? false;
              const isUpdatingStartAt = updatingRoomStartAt[room.name] ?? false;
              const startAtDraft = roomStartAtDrafts[room.name] ?? "";
              const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(urls.audience)}`;

              return (
                <div className={`panel admin-room-card ${isExpanded ? "is-expanded" : ""}`} key={room.name}>
                  <div className="admin-room-top">
                    <div className="admin-room-name-row">
                      <h4>{room.name}</h4>
                      <span className="admin-room-created">
                        Created {new Date(room.created_at).toLocaleDateString()} · Opens{" "}
                        {formatRoomStartAt(room.start_at)}
                      </span>
                    </div>

                    <div className="admin-room-stats-row">
                      {stats ? (
                        <>
                          <span className="admin-stat-chip" title="Participants">
                            <Users size={12} strokeWidth={2} />
                            <strong>
                              <FlowInteger value={stats.participants} />
                            </strong>
                          </span>
                          <span className="admin-stat-chip" title="Questions">
                            Q<FlowInteger value={stats.currentQuestionIndex + 1} />/
                            <FlowInteger value={stats.totalQuestions} />
                          </span>
                          <span className="admin-stat-chip" title="Connections">
                            A:<FlowInteger value={stats.audienceCount} /> H:
                            <FlowInteger value={stats.hostCount} /> P:
                            <FlowInteger value={stats.projectorCount} />
                          </span>
                        </>
                      ) : (
                        <span className="muted" style={{ fontSize: "0.78rem" }}>Loading stats...</span>
                      )}
                    </div>

                    <div className="admin-room-host-key-row">
                      <span className="admin-field-label-inline">Host Key:</span>
                      <code className="admin-host-key-value">
                        {isHostKeyVisible ? room.host_key : "••••••••"}
                      </code>
                      <button
                        type="button"
                        className="admin-icon-btn"
                        onClick={() =>
                          setShowHostKeys((prev) => ({
                            ...prev,
                            [room.name]: !prev[room.name],
                          }))
                        }
                        title={isHostKeyVisible ? "Hide" : "Show"}
                      >
                        {isHostKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>

                    <div className="admin-room-open-time-row">
                      <span className="admin-field-label-inline">Open Time:</span>
                      <input
                        className="text-input admin-room-open-time-input"
                        type="datetime-local"
                        value={startAtDraft}
                        onChange={(event) => {
                          const nextValue = event.currentTarget.value;
                          setRoomStartAtDrafts((prev) => ({
                            ...prev,
                            [room.name]: nextValue,
                          }));
                        }}
                      />
                      <button
                        type="button"
                        className="admin-action-btn admin-action-save-time"
                        onClick={() => handleUpdateRoomStartAt(room)}
                        disabled={isUpdatingStartAt || !startAtDraft.trim()}
                      >
                        {isUpdatingStartAt
                          ? "Saving..."
                          : recentlyUpdatedRoomStartAt === room.name
                            ? "Saved"
                            : "Save Time"}
                      </button>
                    </div>

                    <div className="admin-room-actions">
                      <a className="admin-action-btn" href={`/admin/${encodeURIComponent(room.name)}`}>
                        <ListChecks size={13} strokeWidth={2} />
                        Questions
                      </a>
                      <button
                        type="button"
                        className="admin-action-btn"
                        onClick={() => setExpandedRoom(isExpanded ? null : room.name)}
                      >
                        <Link2 size={13} strokeWidth={2} />
                        Links
                      </button>
                      <button
                        type="button"
                        className="admin-action-btn"
                        onClick={() => setShowQr(isQrVisible ? null : room.name)}
                      >
                        <QrCode size={13} strokeWidth={2} />
                        QR
                      </button>
                      <button
                        type="button"
                        className="admin-action-btn admin-action-reset"
                        onClick={() => handleResetRoom(room.name)}
                      >
                        <RotateCcw size={13} strokeWidth={2} />
                        Reset
                      </button>
                      <button
                        type="button"
                        className="admin-action-btn admin-action-delete"
                        onClick={() => handleDeleteRoom(room.name)}
                      >
                        <Trash2 size={13} strokeWidth={2} />
                      </button>
                    </div>
                  </div>

                  {isQrVisible ? (
                    <div className="admin-qr-section">
                      <img
                        src={qrUrl}
                        alt={`QR code for ${room.name}`}
                        className="admin-qr-image"
                      />
                      <p className="admin-qr-url">{urls.audience}</p>
                    </div>
                  ) : null}

                  {isExpanded ? (
                    <div className="admin-links-section">
                      {(["audience", "projector", "host"] as const).map((target) => {
                        const linkKey = `${room.name}-${target}`;
                        return (
                          <div className="link-row" key={target}>
                            <span className="link-row-label">
                              <Link2 size={14} strokeWidth={2} />
                              {target.charAt(0).toUpperCase() + target.slice(1)}
                            </span>
                            <div className="link-row-actions">
                              <a href={urls[target]} target="_blank" rel="noreferrer">
                                Open
                              </a>
                              <button
                                className="copy-link-btn"
                                onClick={() => copyLink(linkKey, urls[target])}
                                type="button"
                              >
                                {copiedLink === linkKey ? (
                                  <CheckCheck size={14} strokeWidth={2} />
                                ) : (
                                  <Copy size={14} strokeWidth={2} />
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {stats && stats.questions.length > 0 ? (
                    <div className="admin-questions-section">
                      <span className="admin-questions-label">Questions</span>
                      <div className="admin-questions-list">
                        {stats.questions.map((q) => (
                          <div
                            className={`admin-question-row ${q.index === stats.currentQuestionIndex ? "is-current" : ""}`}
                            key={q.id}
                          >
                            <span className="admin-question-index">Q{q.index + 1}</span>
                            <span className="admin-question-prompt">{q.prompt}</span>
                            <span className={`admin-question-phase phase-${q.phase}`}>
                              {q.phase}
                            </span>
                            <span className="admin-question-votes">
                              <FlowInteger value={q.totalVotes} /> votes
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <footer className="app-bottom-bar">
        <span className="app-bottom-left">SynHole Admin</span>
        <div className="app-bottom-right">
          <span>
            <FlowInteger value={rooms.length} /> room{rooms.length !== 1 ? "s" : ""}
          </span>
        </div>
      </footer>
    </main>
  );
}

function FlowInteger(props: { value: number }) {
  return (
    <NumberFlow value={props.value} trend={0} format={{ useGrouping: false, maximumFractionDigits: 0 }} />
  );
}
