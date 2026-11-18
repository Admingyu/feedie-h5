import { useCallback, useEffect, useRef, useState } from "react";
import type RealtimeKitClient from "@cloudflare/realtimekit";
import { ApiError, request } from "./sync";

/** 同一账号下的一条浏览器连接；设备身份只用于路由，账号由服务端会话确定。 */
export type CallDevice = { id: string; name: string; busy: boolean };
/** 来电到通话的界面状态；仅接听完成后才创建音视频 SDK。 */
export type VideoCall = { id: string; peer: string; phase: "calling" | "incoming" | "connecting" | "active" };

/** 管理在线设备、呼叫信令和 RealtimeKit 生命周期；不把参与者令牌写入持久存储。 */
export function useVideoCalls(userId: string | undefined) {
  const [deviceId] = useState(() => crypto.randomUUID());
  const [deviceName] = useState(() => {
    const agent = navigator.userAgent;
    const system = /iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1) ? "iPad" : /iPhone/.test(agent) ? "iPhone" : /Android/.test(agent) ? "Android" : /Macintosh/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows" : "浏览器";
    return `${system} · ${deviceId.slice(0, 4)}`;
  });
  const [status, setStatus] = useState<"offline" | "connecting" | "online">("offline");
  const [devices, setDevices] = useState<CallDevice[]>([]);
  const [call, setCall] = useState<VideoCall | null>(null);
  const [meeting, setMeeting] = useState<RealtimeKitClient | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [, refreshMedia] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const callRef = useRef<VideoCall | null>(null);
  const meetingRef = useRef<RealtimeKitClient | null>(null);

  /** 同步 React 状态与异步 SDK 操作读取的引用，避免挂断后迟到的 join 重新开启摄像头。 */
  const updateCall = useCallback((next: VideoCall | null) => { callRef.current = next; setCall(next); }, []);

  /** 先释放本地采集，再退出云端会话；即使网络已断开，摄像头也立即停止。 */
  const stopMeeting = useCallback(() => {
    const current = meetingRef.current;
    meetingRef.current = null;
    setMeeting(null);
    updateCall(null);
    if (current) {
      current.self.cleanUpTracks();
      void current.leave().catch(() => setError("本机音视频已停止，退出视频服务失败，请检查网络"));
    }
  }, [updateCall]);

  /** 所有信令都经过已鉴权的同源连接；离线时明确告知用户，而不假装呼叫成功。 */
  const send = useCallback((message: object) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) { setError("实时连接已断开，请连接后重试"); return false; }
    socketRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  useEffect(() => {
    if (!userId) return;
    let disposed = false;
    let reconnect: number | undefined;
    let heartbeat: number | undefined;
    let connecting = false;

    /** 登录后只建立设备信令连接；配置缺失停止重试，由界面显示真实错误。 */
    const connect = async () => {
      if (disposed || connecting || !navigator.onLine || socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) return;
      connecting = true;
      if (reconnect !== undefined) clearTimeout(reconnect);
      setStatus("connecting");
      try {
        await request("/api/calls/config");
        if (disposed) return;
        const url = new URL("/api/calls/connect", location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("device", deviceId);
        url.searchParams.set("name", deviceName);
        const socket = new WebSocket(url);
        socketRef.current = socket;
        let lastPong = Date.now();
        socket.onopen = () => {
          if (disposed) { socket.close(); return; }
          setStatus("online"); setError("");
          heartbeat = window.setInterval(() => {
            if (Date.now() - lastPong > 75000) { socket.close(4000, "连接超时"); return; }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
          }, 25000);
        };
        socket.onmessage = async event => {
          if (disposed || socketRef.current !== socket) return;
          lastPong = Date.now();
          let joiningId: string | undefined;
          try {
            const message = JSON.parse(event.data);
            if (message.type === "devices") setDevices(message.devices.filter((device: CallDevice) => device.id !== deviceId));
            if (message.type === "ringing") updateCall({ id: message.id, peer: message.peer, phase: "calling" });
            if (message.type === "incoming") { setError(""); setNotice(""); updateCall({ id: message.id, peer: message.peer, phase: "incoming" }); }
            if (message.type === "ended" && callRef.current?.id === message.id) { setNotice(message.reason); stopMeeting(); }
            if (message.type === "error") { setError(message.message); if (callRef.current?.id === "pending") updateCall(null); }
            if (message.type !== "join") return;
            const id = message.id as string;
            joiningId = id;
            if (callRef.current?.id !== id) return;
            updateCall({ id, peer: message.peer, phase: "connecting" });
            const { default: Client } = await import("@cloudflare/realtimekit");
            if (disposed || callRef.current?.id !== id) return;
            // 先初始化无采集客户端，再显式申请媒体，确保权限错误能显示且及时关闭会议。
            const client = await Client.init({ authToken: message.token, defaults: { audio: false, video: false } });
            if (disposed || callRef.current?.id !== id) { client.self.cleanUpTracks(); await client.leave(); return; }
            meetingRef.current = client;
            setMeeting(client);
            /** SDK 对象是可变对象，媒体与成员事件触发 React 重新读取当前轨道。 */
            const refresh = () => refreshMedia(value => value + 1);
            client.participants.joined.on("participantsUpdate", refresh);
            client.participants.joined.on("participantJoined", refresh);
            client.participants.joined.on("participantLeft", refresh);
            client.participants.joined.on("audioUpdate", refresh);
            client.participants.joined.on("videoUpdate", refresh);
            client.self.on("audioUpdate", refresh);
            client.self.on("videoUpdate", refresh);
            client.self.on("roomLeft", () => {
              if (meetingRef.current !== client) return;
              send({ type: "end", id });
              setNotice("视频连接已结束");
              stopMeeting();
            });
            client.self.on("mediaPermissionError", ({ kind }) => {
              if (meetingRef.current !== client) return;
              setError(`${kind === "video" ? "摄像头" : "麦克风"}不可用，请检查浏览器权限后重试`);
              setNotice("无法开启视频通话");
              send({ type: "end", id }); stopMeeting();
            });
            await Promise.all([client.self.enableAudio(), client.self.enableVideo()]);
            if (disposed || callRef.current?.id !== id) { client.self.cleanUpTracks(); await client.leave(); return; }
            await client.join();
            if (disposed || callRef.current?.id !== id) { client.self.cleanUpTracks(); await client.leave(); return; }
            send({ type: "joined", id });
            updateCall({ id, peer: message.peer, phase: "active" });
            refresh();
          } catch (cause) {
            if (disposed || joiningId && callRef.current?.id !== joiningId) return;
            setError(`视频连接失败：${cause instanceof Error ? cause.message : "请检查设备权限和网络"}`);
            setNotice("无法建立视频通话");
            if (callRef.current) send({ type: "end", id: callRef.current.id });
            stopMeeting();
          }
        };
        socket.onclose = event => {
          if (socketRef.current !== socket) return;
          socketRef.current = null;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          setStatus("offline"); setDevices([]); stopMeeting();
          if (disposed) return;
          setError(event.code === 4001 ? "登录已过期，请重新登录" : "设备连接已断开，正在重新连接");
          if (event.code !== 4001) reconnect = window.setTimeout(() => void connect(), 5000);
        };
      } catch (cause) {
        if (disposed) return;
        setStatus("offline");
        setError(cause instanceof Error ? cause.message : "无法连接视频服务");
        if (!(cause instanceof ApiError && [401, 503].includes(cause.status))) reconnect = window.setTimeout(() => void connect(), 5000);
      } finally { connecting = false; }
    };
    /** 返回前台或联网时恢复设备发现；系统后台无法保证持续接听。 */
    const resume = () => { if (document.visibilityState === "visible") void connect(); };
    void connect();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      if (reconnect !== undefined) clearTimeout(reconnect);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(1000, "离开页面");
      stopMeeting(); setDevices([]); setStatus("offline"); setError(""); setNotice("");
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [userId, deviceId, deviceName, retry, send, stopMeeting, updateCall]);

  /** 主叫在收到服务端 call ID 前保持等待，重复点击不会创建多通会议。 */
  const start = (device: CallDevice) => {
    if (callRef.current) return;
    setError(""); setNotice("");
    if (send({ type: "call", target: device.id })) updateCall({ id: "pending", peer: device.name, phase: "calling" });
  };
  /** 被叫主动接听；服务端确认后才签发媒体凭证。 */
  const accept = () => {
    const current = callRef.current;
    setError(""); setNotice("");
    if (current?.phase === "incoming" && send({ type: "accept", id: current.id })) updateCall({ ...current, phase: "connecting" });
  };
  /** 取消、拒绝、挂断共用结束路径，本地媒体释放不依赖网络请求成功。 */
  const end = () => {
    const current = callRef.current;
    if (current) send({ type: "end", id: current.id, reason: current.phase === "incoming" ? "reject" : "hangup" });
    stopMeeting(); setNotice("通话已结束");
  };
  /** 静音和关闭摄像头是 SDK 的显式操作，失败直接显示给用户。 */
  const toggle = async (kind: "audio" | "video") => {
    const current = meetingRef.current;
    if (!current || callRef.current?.phase !== "active") return;
    try {
      if (kind === "audio") await (current.self.audioEnabled ? current.self.disableAudio() : current.self.enableAudio());
      else await (current.self.videoEnabled ? current.self.disableVideo() : current.self.enableVideo());
      refreshMedia(value => value + 1);
    } catch (cause) { setError(`操作失败：${cause instanceof Error ? cause.message : "请检查设备权限"}`); }
  };
  return { deviceName, status, devices, call, meeting, error, notice, start, accept, end, toggle, reconnect: () => setRetry(value => value + 1) };
}
