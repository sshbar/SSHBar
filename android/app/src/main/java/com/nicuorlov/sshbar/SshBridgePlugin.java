package com.nicuorlov.sshbar;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import net.schmizz.sshj.DefaultConfig;
import net.schmizz.sshj.SSHClient;
import net.schmizz.sshj.common.Buffer;
import net.schmizz.sshj.common.KeyType;
import net.schmizz.sshj.connection.channel.direct.DirectConnection;
import net.schmizz.sshj.connection.channel.direct.PTYMode;
import net.schmizz.sshj.connection.channel.direct.Session;
import net.schmizz.sshj.transport.verification.HostKeyVerifier;
import net.schmizz.sshj.userauth.UserAuthException;
import net.schmizz.sshj.userauth.keyprovider.KeyProvider;
import net.schmizz.sshj.userauth.method.AuthKeyboardInteractive;
import net.schmizz.sshj.userauth.method.ChallengeResponseProvider;
import net.schmizz.sshj.userauth.password.PasswordFinder;
import net.schmizz.sshj.userauth.password.Resource;

import org.bouncycastle.jce.provider.BouncyCastleProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Security;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Native half of SSHbar on Android: SSH connections through sshj, encrypted on-device storage
 * (Android Keystore) and a few platform services. Policy (host key trust, auth order, prompts)
 * lives in TypeScript (src/mobile/session.ts); this class only performs the steps it is asked to.
 */
@CapacitorPlugin(name = "SshBridge")
public class SshBridgePlugin extends Plugin {

    static {
        // Android ships a stripped-down "BC" provider; replace it with the full BouncyCastle that sshj
        // expects. Added last so Android's own providers (Keystore, Conscrypt) keep priority.
        Security.removeProvider("BC");
        Security.addProvider(new BouncyCastleProvider());
    }

    private static final String KEY_ALIAS = "sshbar-secrets";
    private static final String PREFS = "sshbar-secure";

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, Conn> conns = new ConcurrentHashMap<>();
    private final Map<String, CompletableFuture<String>> kbdAnswers = new ConcurrentHashMap<>();

    private static final class Conn {
        final SSHClient client;
        Session shellSession;
        Session.Shell shell;
        final Map<String, Session> execs = new ConcurrentHashMap<>();
        volatile boolean closing;
        volatile boolean closedEmitted;

        Conn(SSHClient client) {
            this.client = client;
        }
    }

    // ------------------------------------------------------------------ helpers

    private static String b64(byte[] data, int len) {
        return Base64.encodeToString(data, 0, len, Base64.NO_WRAP);
    }

    private static String friendly(Throwable e, String host, int port) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t && !(t instanceof UnknownHostException) && !(t instanceof ConnectException)) t = t.getCause();
        String where = host + ":" + port;
        if (t instanceof UnknownHostException) return "Host not found (" + where + ")";
        if (t instanceof ConnectException) return "Connection refused (" + where + ")";
        if (t instanceof NoRouteToHostException) return "Host unreachable (" + where + ")";
        if (t instanceof SocketTimeoutException) return "Connection to " + where + " timed out";
        String m = e.getMessage();
        return m != null ? m : e.getClass().getSimpleName();
    }

    private Conn conn(PluginCall call) {
        Conn c = conns.get(call.getString("id", ""));
        if (c == null) call.reject("This connection is closed");
        return c;
    }

    private void emitClosed(String id, Conn c, String reason) {
        if (c.closedEmitted) return;
        c.closedEmitted = true;
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("reason", reason == null ? "" : reason);
        notifyListeners("closed", o);
    }

    private static List<String> allowed(SSHClient c) {
        List<String> out = new ArrayList<>();
        try {
            Collection<String> m = c.getUserAuth().getAllowedMethods();
            if (m != null) out.addAll(m);
        } catch (Exception ignored) {
        }
        return out;
    }

    private void resolveAuth(PluginCall call, SSHClient c, boolean ok) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("allowed", new JSArray(ok ? new ArrayList<String>() : allowed(c)));
        boolean partial = false;
        try {
            partial = !ok && c.getUserAuth().hadPartialSuccess();
        } catch (Exception ignored) {
        }
        r.put("partial", partial);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ platform services

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject r = new JSObject();
        try {
            r.put("version", getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName);
        } catch (Exception e) {
            r.put("version", "");
        }
        call.resolve(r);
    }

    @PluginMethod
    public void readText(PluginCall call) {
        File f = new File(getContext().getFilesDir(), safeName(call.getString("name", "")));
        JSObject r = new JSObject();
        try {
            r.put("data", f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : null);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read " + f.getName() + ": " + e.getMessage());
        }
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        File dir = getContext().getFilesDir();
        String name = safeName(call.getString("name", ""));
        File tmp = new File(dir, name + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(call.getString("data", "").getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (Exception e) {
            call.reject("Could not write " + name + ": " + e.getMessage());
            return;
        }
        if (!tmp.renameTo(new File(dir, name))) {
            call.reject("Could not save " + name);
            return;
        }
        call.resolve();
    }

    private static String safeName(String n) {
        if (!n.matches("[A-Za-z0-9_.-]{1,64}") || n.startsWith(".")) throw new IllegalArgumentException("Invalid file name");
        return n;
    }

    private SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            return kg.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(call.getString("value", "").getBytes(StandardCharsets.UTF_8));
            byte[] blob = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, blob, 0, iv.length);
            System.arraycopy(ct, 0, blob, iv.length, ct.length);
            prefs().edit().putString(call.getString("key", ""), b64(blob, blob.length)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Secure storage failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        JSObject r = new JSObject();
        String stored = prefs().getString(call.getString("key", ""), null);
        if (stored == null) {
            r.put("value", null);
            call.resolve(r);
            return;
        }
        try {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, blob, 0, 12));
            r.put("value", new String(c.doFinal(blob, 12, blob.length - 12), StandardCharsets.UTF_8));
        } catch (Exception e) {
            r.put("value", null); // unreadable (e.g. key invalidated): behave as missing
        }
        call.resolve(r);
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        prefs().edit().remove(call.getString("key", "")).apply();
        call.resolve();
    }

    @PluginMethod
    public void clipboardRead(PluginCall call) {
        ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        JSObject r = new JSObject();
        CharSequence text = "";
        if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
            text = cm.getPrimaryClip().getItemAt(0).coerceToText(getContext());
        }
        r.put("text", text == null ? "" : text.toString());
        call.resolve(r);
    }

    @PluginMethod
    public void clipboardWrite(PluginCall call) {
        ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("SSHbar", call.getString("text", "")));
        call.resolve();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.matches("(?i)^(https?://|mailto:).*")) {
            call.reject("Unsupported link");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // ------------------------------------------------------------------ SSH

    /** TCP (or a tunnel through another connection) + key exchange. Returns the server's host key. */
    @PluginMethod
    public void sshOpen(PluginCall call) {
        final String id = call.getString("id", "");
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 22);
        final String viaId = call.getString("viaId");
        pool.execute(() -> {
            final PublicKey[] seen = new PublicKey[1];
            SSHClient client = new SSHClient(new DefaultConfig());
            try {
                client.setConnectTimeout(15000);
                client.addHostKeyVerifier(new HostKeyVerifier() {
                    @Override
                    public boolean verify(String h, int p, PublicKey key) {
                        seen[0] = key; // the decision is made in TypeScript before any credential is sent
                        return true;
                    }

                    @Override
                    public List<String> findExistingAlgorithms(String h, int p) {
                        return Collections.emptyList();
                    }
                });
                if (viaId != null && !viaId.isEmpty()) {
                    Conn via = conns.get(viaId);
                    if (via == null) throw new IllegalStateException("The jump host connection is closed");
                    DirectConnection dc = via.client.newDirectConnection(host, port);
                    client.connectVia(dc);
                } else {
                    client.connect(host, port);
                }
                client.getConnection().getKeepAlive().setKeepAliveInterval(15);
                final Conn c = new Conn(client);
                conns.put(id, c);
                client.getTransport().setDisconnectListener((reason, message) -> {
                    if (!c.closing) emitClosed(id, c, message);
                });
                byte[] blob = new Buffer.PlainBuffer().putPublicKey(seen[0]).getCompactData();
                String fp = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(blob), Base64.NO_WRAP | Base64.NO_PADDING);
                JSObject r = new JSObject();
                r.put("keyType", KeyType.fromKey(seen[0]).toString());
                r.put("fingerprint", "SHA256:" + fp);
                r.put("key", b64(blob, blob.length));
                call.resolve(r);
            } catch (Exception e) {
                try {
                    client.disconnect();
                } catch (Exception ignored) {
                }
                call.reject(friendly(e, host, port));
            }
        });
    }

    @PluginMethod
    public void sshAuthPassword(PluginCall call) {
        Conn c = conn(call);
        if (c == null) return;
        final String user = call.getString("username", "");
        final String pw = call.getString("password", "");
        pool.execute(() -> {
            try {
                c.client.authPassword(user, pw);
                resolveAuth(call, c.client, true);
            } catch (UserAuthException e) {
                resolveAuth(call, c.client, false);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    private static PasswordFinder oneOff(final String passphrase, final boolean[] asked) {
        return new PasswordFinder() {
            @Override
            public char[] reqPassword(Resource<?> resource) {
                asked[0] = true;
                return passphrase == null ? new char[0] : passphrase.toCharArray();
            }

            @Override
            public boolean shouldRetry(Resource<?> resource) {
                return false;
            }
        };
    }

    @PluginMethod
    public void sshKeyInfo(PluginCall call) {
        final String key = call.getString("privateKey", "");
        final String pass = call.getString("passphrase");
        pool.execute(() -> {
            boolean[] asked = {false};
            JSObject r = new JSObject();
            try {
                KeyProvider kp = new SSHClient(new DefaultConfig()).loadKeys(key, null, oneOff(pass, asked));
                kp.getPrivate();
                r.put("valid", true);
            } catch (Exception e) {
                r.put("valid", false);
                r.put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
            r.put("needsPassphrase", asked[0]);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void sshAuthKey(PluginCall call) {
        Conn c = conn(call);
        if (c == null) return;
        final String user = call.getString("username", "");
        final String key = call.getString("privateKey", "");
        final String pass = call.getString("passphrase");
        pool.execute(() -> {
            try {
                KeyProvider kp = c.client.loadKeys(key, null, oneOff(pass, new boolean[1]));
                c.client.authPublickey(user, kp);
                resolveAuth(call, c.client, true);
            } catch (UserAuthException e) {
                resolveAuth(call, c.client, false);
            } catch (Exception e) {
                call.reject("Could not use the private key: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void sshAuthKeyboard(PluginCall call) {
        Conn c = conn(call);
        if (c == null) return;
        final String id = call.getString("id", "");
        final String user = call.getString("username", "");
        pool.execute(() -> {
            try {
                c.client.auth(user, new AuthKeyboardInteractive(new ChallengeResponseProvider() {
                    private String name = "";
                    private String instruction = "";

                    @Override
                    public List<String> getSubmethods() {
                        return Collections.emptyList();
                    }

                    @Override
                    public void init(Resource resource, String name, String instruction) {
                        this.name = name == null ? "" : name;
                        this.instruction = instruction == null ? "" : instruction;
                    }

                    @Override
                    public char[] getResponse(String prompt, boolean echo) {
                        String requestId = UUID.randomUUID().toString();
                        CompletableFuture<String> f = new CompletableFuture<>();
                        kbdAnswers.put(requestId, f);
                        JSObject ev = new JSObject();
                        ev.put("id", id);
                        ev.put("requestId", requestId);
                        ev.put("name", name);
                        ev.put("instruction", instruction);
                        ev.put("prompt", prompt);
                        ev.put("echo", echo);
                        notifyListeners("kbdPrompt", ev);
                        try {
                            String a = f.get(5, TimeUnit.MINUTES);
                            return a == null ? new char[0] : a.toCharArray();
                        } catch (Exception e) {
                            return new char[0];
                        } finally {
                            kbdAnswers.remove(requestId);
                        }
                    }

                    @Override
                    public boolean shouldRetry() {
                        return false;
                    }
                }));
                resolveAuth(call, c.client, true);
            } catch (UserAuthException e) {
                resolveAuth(call, c.client, false);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void sshKeyboardRespond(PluginCall call) {
        CompletableFuture<String> f = kbdAnswers.get(call.getString("requestId", ""));
        if (f != null) f.complete(call.getString("answer"));
        call.resolve();
    }

    @PluginMethod
    public void sshShell(PluginCall call) {
        Conn c = conn(call);
        if (c == null) return;
        final String id = call.getString("id", "");
        final int cols = call.getInt("cols", 80);
        final int rows = call.getInt("rows", 24);
        pool.execute(() -> {
            try {
                Session s = c.client.startSession();
                s.allocatePTY("xterm-256color", cols, rows, 0, 0, Collections.<PTYMode, Integer>emptyMap());
                Session.Shell shell = s.startShell();
                c.shellSession = s;
                c.shell = shell;
                call.resolve();
                InputStream in = shell.getInputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    JSObject ev = new JSObject();
                    ev.put("id", id);
                    ev.put("data", b64(buf, n));
                    notifyListeners("data", ev);
                }
                if (!c.closing) emitClosed(id, c, "Shell exited");
            } catch (Exception e) {
                if (c.shell == null) call.reject("Could not open a shell: " + e.getMessage());
                else if (!c.closing) emitClosed(id, c, e.getMessage());
            }
        });
    }

    @PluginMethod
    public void sshWrite(PluginCall call) {
        Conn c = conns.get(call.getString("id", ""));
        // runs on Capacitor's plugin thread, one call at a time, so keystrokes keep their order
        if (c != null && c.shell != null) {
            try {
                OutputStream out = c.shell.getOutputStream();
                out.write(call.getString("data", "").getBytes(StandardCharsets.UTF_8));
                out.flush();
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void sshResize(PluginCall call) {
        Conn c = conns.get(call.getString("id", ""));
        if (c != null && c.shell != null) {
            try {
                c.shell.changeWindowDimensions(call.getInt("cols", 80), call.getInt("rows", 24), 0, 0);
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void sshExec(PluginCall call) {
        Conn c = conn(call);
        if (c == null) return;
        final String id = call.getString("id", "");
        final String execId = call.getString("execId", "");
        final String command = call.getString("command", "");
        pool.execute(() -> {
            Session s = null;
            try {
                s = c.client.startSession();
                c.execs.put(execId, s);
                Session.Command cmd = s.exec(command);
                call.resolve();
                InputStream in = cmd.getInputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    JSObject ev = new JSObject();
                    ev.put("id", id);
                    ev.put("execId", execId);
                    ev.put("data", b64(buf, n));
                    notifyListeners("execData", ev);
                }
            } catch (Exception e) {
                if (s == null) call.reject(e.getMessage());
            } finally {
                c.execs.remove(execId);
                if (s != null) {
                    try {
                        s.close();
                    } catch (Exception ignored) {
                    }
                }
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("execId", execId);
                notifyListeners("execClosed", ev);
            }
        });
    }

    @PluginMethod
    public void sshExecClose(PluginCall call) {
        Conn c = conns.get(call.getString("id", ""));
        Session s = c == null ? null : c.execs.remove(call.getString("execId", ""));
        if (s != null) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void sshClose(PluginCall call) {
        Conn c = conns.remove(call.getString("id", ""));
        if (c != null) pool.execute(() -> closeQuietly(c));
        call.resolve();
    }

    private static void closeQuietly(Conn c) {
        c.closing = true;
        for (Session s : c.execs.values()) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
        try {
            if (c.shellSession != null) c.shellSession.close();
        } catch (Exception ignored) {
        }
        try {
            c.client.disconnect();
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (Conn c : conns.values()) closeQuietly(c);
        conns.clear();
        pool.shutdownNow();
    }
}
