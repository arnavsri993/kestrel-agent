package dev.kestrel.jetbrains;

import com.google.gson.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import java.awt.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public final class KestrelToolWindowFactory implements ToolWindowFactory {
    @Override public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        KestrelPanel panel = new KestrelPanel(project);
        Content content = ContentFactory.getInstance().createContent(panel.component, "Task", false);
        content.setDisposer(panel);
        toolWindow.getContentManager().addContent(content);
    }
}

final class KestrelPanel implements Disposable {
    final JPanel component = new JPanel(new BorderLayout(8, 8));
    private final JTextArea transcript = new JTextArea();
    private final JTextArea prompt = new JTextArea(4, 40);
    private final JButton start = new JButton("Start task");
    private final JButton cancel = new JButton("Cancel");
    private final Project project;
    private AcpPeer peer;

    KestrelPanel(Project project) {
        this.project = project; transcript.setEditable(false); transcript.setLineWrap(true); transcript.setWrapStyleWord(true);
        JPanel actions = new JPanel(new FlowLayout(FlowLayout.RIGHT)); actions.add(cancel); actions.add(start); cancel.setEnabled(false);
        JPanel composer = new JPanel(new BorderLayout(6, 6)); composer.add(new JScrollPane(prompt), BorderLayout.CENTER); composer.add(actions, BorderLayout.SOUTH);
        component.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8)); component.add(new JScrollPane(transcript), BorderLayout.CENTER); component.add(composer, BorderLayout.SOUTH);
        start.addActionListener(event -> start()); cancel.addActionListener(event -> { if (peer != null) peer.cancel(); });
    }

    private void start() {
        String text = prompt.getText().trim(); String root = project.getBasePath(); if (text.isEmpty() || root == null) return;
        start.setEnabled(false); cancel.setEnabled(true); prompt.setText(""); transcript.append("You: " + text + "\n\n");
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try { if (peer != null) peer.close(); peer = new AcpPeer(project, root, this::append); peer.run(text); }
            catch (Exception error) { append("\nError: " + error.getMessage() + "\n"); }
            finally { SwingUtilities.invokeLater(() -> { start.setEnabled(true); cancel.setEnabled(false); }); }
        });
    }
    private void append(String value) { SwingUtilities.invokeLater(() -> { transcript.append(value); transcript.setCaretPosition(transcript.getDocument().getLength()); }); }
    @Override public void dispose() { if (peer != null) peer.close(); }
}

final class AcpPeer implements AutoCloseable {
    private final Project project; private final Path root; private final java.util.function.Consumer<String> output; private final Gson gson = new Gson();
    private final AtomicInteger ids = new AtomicInteger(); private final Map<Integer, CompletableFuture<JsonElement>> pending = new ConcurrentHashMap<>(); private final Map<String, TerminalRun> terminals = new ConcurrentHashMap<>();
    private Process process; private BufferedWriter writer; private volatile String sessionId;

    AcpPeer(Project project, String workspace, java.util.function.Consumer<String> output) throws IOException {
        this.project = project; this.root = Path.of(workspace).toRealPath(); this.output = output;
        String executable = Optional.ofNullable(System.getenv("KESTREL_ACP_PATH")).filter(value -> !value.isBlank()).orElse("kestrel-acp");
        ProcessBuilder builder = new ProcessBuilder(executable, "--workspace", root.toString()); builder.directory(root.toFile()); process = builder.start(); writer = process.outputWriter(StandardCharsets.UTF_8);
        Thread.ofVirtual().name("kestrel-acp-reader").start(this::readLoop); Thread.ofVirtual().start(() -> { try (Reader errors = process.errorReader(StandardCharsets.UTF_8)) { char[] chars = new char[2048]; int count; while ((count = errors.read(chars)) >= 0) output.accept(new String(chars, 0, count)); } catch (IOException ignored) {} });
    }

    void run(String prompt) throws Exception {
        JsonObject initialize = new JsonObject(); initialize.addProperty("protocolVersion", 1); initialize.add("clientInfo", gson.toJsonTree(Map.of("name", "Kestrel JetBrains", "version", "0.1.0"))); initialize.add("clientCapabilities", gson.toJsonTree(Map.of("fs", Map.of("readTextFile", true, "writeTextFile", true), "terminal", true)));
        request("initialize", initialize).get(30, TimeUnit.SECONDS); JsonObject create = new JsonObject(); create.addProperty("cwd", root.toString()); create.add("mcpServers", new JsonArray()); sessionId = request("session/new", create).get(30, TimeUnit.SECONDS).getAsJsonObject().get("sessionId").getAsString();
        JsonObject turn = new JsonObject(); turn.addProperty("sessionId", sessionId); turn.add("prompt", gson.toJsonTree(List.of(Map.of("type", "text", "text", prompt)))); JsonElement result = request("session/prompt", turn).get(); output.accept("\n[" + result.getAsJsonObject().get("stopReason").getAsString() + "]\n");
    }

    private CompletableFuture<JsonElement> request(String method, JsonObject params) throws IOException { int id = ids.incrementAndGet(); JsonObject message = envelope(method, params); message.addProperty("id", id); CompletableFuture<JsonElement> future = new CompletableFuture<>(); pending.put(id, future); send(message); return future; }
    private JsonObject envelope(String method, JsonObject params) { JsonObject message = new JsonObject(); message.addProperty("jsonrpc", "2.0"); message.addProperty("method", method); message.add("params", params); return message; }
    private synchronized void send(JsonObject message) throws IOException { writer.write(gson.toJson(message)); writer.newLine(); writer.flush(); }
    private void readLoop() { try (BufferedReader reader = process.inputReader(StandardCharsets.UTF_8)) { String line; while ((line = reader.readLine()) != null) dispatch(JsonParser.parseString(line).getAsJsonObject()); } catch (Exception error) { pending.values().forEach(future -> future.completeExceptionally(error)); } }

    private void dispatch(JsonObject message) throws Exception {
        if (message.has("id") && !message.has("method")) { CompletableFuture<JsonElement> future = pending.remove(message.get("id").getAsInt()); if (future != null) { if (message.has("error")) future.completeExceptionally(new IOException(message.getAsJsonObject("error").get("message").getAsString())); else future.complete(message.get("result")); } return; }
        if (!message.has("method")) return; String method = message.get("method").getAsString(); JsonObject params = message.has("params") ? message.getAsJsonObject("params") : new JsonObject();
        if (!message.has("id")) { if (method.equals("session/update")) update(params.getAsJsonObject("update")); return; }
        int id = message.get("id").getAsInt(); handle(method, params).whenComplete((result, error) -> { JsonObject response = new JsonObject(); response.addProperty("jsonrpc", "2.0"); response.addProperty("id", id); if (error == null) response.add("result", result); else response.add("error", gson.toJsonTree(Map.of("code", -32603, "message", error.getMessage()))); try { send(response); } catch (IOException ignored) {} });
    }

    private void update(JsonObject update) { String kind = update.get("sessionUpdate").getAsString(); if (kind.equals("agent_message_chunk")) { JsonObject content = update.getAsJsonObject("content"); if (content.get("type").getAsString().equals("text")) output.accept(content.get("text").getAsString()); } else if (kind.equals("tool_call")) output.accept("\n▶ " + update.get("title").getAsString() + "\n"); else if (kind.equals("tool_call_update")) output.accept("  " + update.get("status").getAsString() + "\n"); }
    private CompletableFuture<JsonElement> handle(String method, JsonObject params) {
        try {
            return switch (method) {
                case "session/request_permission" -> uiPermission(params);
                case "fs/read_text_file" -> completed(gson.toJsonTree(Map.of("content", Files.readString(contained(params.get("path").getAsString(), false)))));
                case "fs/write_text_file" -> { Path target = contained(params.get("path").getAsString(), true); Files.writeString(target, params.get("content").getAsString(), StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING); LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target); yield completed(new JsonObject()); }
                case "terminal/create" -> completed(createTerminal(params));
                case "terminal/wait_for_exit" -> terminals.get(params.get("terminalId").getAsString()).exit.thenApply(status -> gson.toJsonTree(status));
                case "terminal/output" -> completed(terminals.get(params.get("terminalId").getAsString()).outputJson(gson));
                case "terminal/kill" -> { terminals.get(params.get("terminalId").getAsString()).process.destroy(); yield completed(new JsonObject()); }
                case "terminal/release" -> { TerminalRun terminal = terminals.remove(params.get("terminalId").getAsString()); if (terminal != null && terminal.process.isAlive()) terminal.process.destroy(); yield completed(new JsonObject()); }
                default -> CompletableFuture.failedFuture(new IOException("Unsupported ACP client method " + method));
            };
        } catch (Exception error) { return CompletableFuture.failedFuture(error); }
    }
    private CompletableFuture<JsonElement> uiPermission(JsonObject params) { CompletableFuture<JsonElement> future = new CompletableFuture<>(); ApplicationManager.getApplication().invokeLater(() -> { JsonObject tool = params.getAsJsonObject("toolCall"); int choice = Messages.showYesNoDialog(project, tool.get("title").getAsString() + "\n" + gson.toJson(tool.get("rawInput")), "Kestrel approval", "Allow once", "Reject", Messages.getWarningIcon()); String kind = choice == Messages.YES ? "allow_once" : "reject_once"; String optionId = params.getAsJsonArray("options").asList().stream().map(JsonElement::getAsJsonObject).filter(item -> item.get("kind").getAsString().equals(kind)).findFirst().orElseThrow().get("optionId").getAsString(); future.complete(gson.toJsonTree(Map.of("outcome", Map.of("outcome", "selected", "optionId", optionId)))); }); return future; }
    private Path contained(String requested, boolean write) throws IOException { Path input = Path.of(requested); if (!input.isAbsolute()) throw new IOException("ACP paths must be absolute."); Path candidate = write && !Files.exists(input) ? input.normalize().toAbsolutePath() : input.toRealPath(); Path parent = write && !Files.exists(candidate) ? candidate.getParent().toRealPath() : candidate; if ((!candidate.equals(root) && !candidate.startsWith(root)) || (!parent.equals(root) && !parent.startsWith(root))) throw new IOException("ACP path escapes the open project."); return candidate; }
    private JsonElement createTerminal(JsonObject params) throws IOException { String id = "terminal-" + UUID.randomUUID(); List<String> command = new ArrayList<>(); command.add(params.get("command").getAsString()); if (params.has("args")) params.getAsJsonArray("args").forEach(item -> command.add(item.getAsString())); Path cwd = contained(params.has("cwd") ? params.get("cwd").getAsString() : root.toString(), false); ProcessBuilder builder = new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true); Process child = builder.start(); TerminalRun run = new TerminalRun(child, Math.min(params.has("outputByteLimit") ? params.get("outputByteLimit").getAsInt() : 1_000_000, 1_000_000)); terminals.put(id, run); output.accept("\n$ " + String.join(" ", command) + "\n"); return gson.toJsonTree(Map.of("terminalId", id)); }
    private static CompletableFuture<JsonElement> completed(JsonElement value) { return CompletableFuture.completedFuture(value); }
    void cancel() { if (sessionId == null) return; try { JsonObject params = new JsonObject(); params.addProperty("sessionId", sessionId); send(envelope("session/cancel", params)); } catch (IOException ignored) {} }
    @Override public void close() { cancel(); terminals.values().forEach(item -> item.process.destroy()); if (process != null) process.destroy(); pending.values().forEach(future -> future.completeExceptionally(new IOException("Kestrel editor client closed."))); pending.clear(); }
}

final class TerminalRun {
    final Process process; final CompletableFuture<Map<String, Object>> exit = new CompletableFuture<>(); private final ByteArrayOutputStream bytes = new ByteArrayOutputStream(); private final int limit; private volatile boolean truncated;
    TerminalRun(Process process, int limit) { this.process = process; this.limit = limit; Thread.ofVirtual().start(() -> { try (InputStream input = process.getInputStream()) { byte[] chunk = new byte[4096]; int count; while ((count = input.read(chunk)) >= 0) synchronized (bytes) { bytes.write(chunk, 0, count); if (bytes.size() > limit) { byte[] tail = bytes.toByteArray(); bytes.reset(); bytes.write(tail, tail.length - limit, limit); truncated = true; } } int code = process.waitFor(); exit.complete(Map.of("exitCode", code)); } catch (Exception error) { exit.completeExceptionally(error); } }); }
    JsonElement outputJson(Gson gson) { synchronized (bytes) { return gson.toJsonTree(Map.of("output", bytes.toString(StandardCharsets.UTF_8), "truncated", truncated)); } }
}
