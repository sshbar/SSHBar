package com.nicuorlov.sshbar;

import com.hierynomus.msdtyp.AccessMask;
import com.hierynomus.mserref.NtStatus;
import com.hierynomus.msfscc.FileAttributes;
import com.hierynomus.msfscc.fileinformation.FileIdBothDirectoryInformation;
import com.hierynomus.mssmb2.SMB2CreateDisposition;
import com.hierynomus.mssmb2.SMB2CreateOptions;
import com.hierynomus.mssmb2.SMB2ShareAccess;
import com.hierynomus.mssmb2.SMBApiException;
import com.hierynomus.protocol.commons.EnumWithValue;
import com.hierynomus.smbj.SMBClient;
import com.hierynomus.smbj.SmbConfig;
import com.hierynomus.smbj.auth.AuthenticationContext;
import com.hierynomus.smbj.connection.Connection;
import com.hierynomus.smbj.session.Session;
import com.hierynomus.smbj.share.DiskShare;
import com.hierynomus.smbj.share.File;
import com.hierynomus.smbj.share.Share;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Files on an SMB share (a NAS or a Windows shared folder) through smbj, so the sync file can live on
 * the same share the computers use without a separate Android app. Plain Java on purpose: it has no
 * Android dependencies and can be exercised on a desktop JVM against a test Samba server.
 */
final class SmbFiles {

    static final class Target {
        String host = "";
        int port = 445;
        String share = "";
        /** "user", "DOMAIN\\user" or "user@domain"; empty for guest access */
        String username = "";
        String password = "";
    }

    static final class Entry {
        final String name;
        final boolean dir;
        final long size;
        final long modified;

        Entry(String name, boolean dir, long size, long modified) {
            this.name = name;
            this.dir = dir;
            this.size = size;
            this.modified = modified;
        }
    }

    /** A message meant for the user (wrong password, missing share…), already worded. */
    static final class SmbError extends IOException {
        SmbError(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private interface ShareOp<T> {
        T run(DiskShare share) throws Exception;
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    // Encryption is used whenever the server speaks SMB 3; older servers still work unencrypted.
    private static final SmbConfig CONFIG = SmbConfig.builder()
            .withTimeout(20, TimeUnit.SECONDS)
            .withSoTimeout(30, TimeUnit.SECONDS)
            .withEncryptData(true)
            .build();

    private SmbFiles() {
    }

    /** "a/b\\c/" → "a\\b\\c" (share-relative, no leading or trailing separator). */
    static String smbPath(String p) {
        StringBuilder out = new StringBuilder();
        for (String part : (p == null ? "" : p).split("[/\\\\]+")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..")) throw new IllegalArgumentException("Paths may not contain ..");
            if (out.length() > 0) out.append('\\');
            out.append(part);
        }
        return out.toString();
    }

    static List<Entry> list(Target t, String dir) throws IOException {
        final String path = smbPath(dir);
        return withShare(t, share -> {
            List<Entry> out = new ArrayList<>();
            for (FileIdBothDirectoryInformation f : share.list(path)) {
                String name = f.getFileName();
                if (name.equals(".") || name.equals("..")) continue;
                boolean isDir = EnumWithValue.EnumUtils.isSet(f.getFileAttributes(), FileAttributes.FILE_ATTRIBUTE_DIRECTORY);
                out.add(new Entry(name, isDir, isDir ? 0 : f.getEndOfFile(), f.getLastWriteTime().toEpochMillis()));
            }
            Collections.sort(out, (a, b) -> a.dir != b.dir ? (a.dir ? -1 : 1) : a.name.compareToIgnoreCase(b.name));
            return out;
        }, path);
    }

    /** The file's bytes, or null when it does not exist yet (the folder must exist). */
    static byte[] read(Target t, String filePath) throws IOException {
        final String path = smbPath(filePath);
        return withShare(t, share -> {
            try (File f = share.openFile(path, EnumSet.of(AccessMask.GENERIC_READ), null, SMB2ShareAccess.ALL, SMB2CreateDisposition.FILE_OPEN,
                    EnumSet.of(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE))) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                f.read(out);
                return out.toByteArray();
            } catch (SMBApiException e) {
                if (e.getStatus() == NtStatus.STATUS_OBJECT_NAME_NOT_FOUND) return null;
                throw e;
            }
        }, path);
    }

    /**
     * Replace the file in one step, like the desktop app: write a temporary file next to it, then rename
     * it over the old one, so a computer reading at the same moment never sees half a file.
     */
    static void write(Target t, String filePath, byte[] data) throws IOException {
        final String path = smbPath(filePath);
        if (path.isEmpty()) throw new SmbError("Choose a file name", null);
        final String tmp = path + "." + String.format(Locale.ROOT, "%08x", RANDOM.nextInt()) + ".tmp";
        withShare(t, share -> {
            boolean renamed = false;
            try (File f = share.openFile(tmp, EnumSet.of(AccessMask.GENERIC_WRITE, AccessMask.DELETE), null, SMB2ShareAccess.ALL,
                    SMB2CreateDisposition.FILE_OVERWRITE_IF, EnumSet.of(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE))) {
                try (OutputStream out = f.getOutputStream()) {
                    out.write(data);
                }
                try {
                    f.rename(path, true);
                    renamed = true;
                } catch (SMBApiException e) {
                    // some servers refuse to replace a file another client has open; overwrite in place instead
                    if (e.getStatus() != NtStatus.STATUS_ACCESS_DENIED && e.getStatus() != NtStatus.STATUS_SHARING_VIOLATION) throw e;
                }
            } finally {
                if (!renamed) {
                    try {
                        share.rm(tmp);
                    } catch (Exception ignored) {
                        // best effort; a leftover .tmp file is harmless
                    }
                }
            }
            if (!renamed) {
                try (File f = share.openFile(path, EnumSet.of(AccessMask.GENERIC_WRITE), null, SMB2ShareAccess.ALL,
                        SMB2CreateDisposition.FILE_OVERWRITE_IF, EnumSet.of(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE));
                        OutputStream out = f.getOutputStream()) {
                    out.write(data);
                }
            }
            return null;
        }, path);
    }

    // ------------------------------------------------------------------ plumbing

    private static AuthenticationContext auth(Target t) {
        String user = t.username == null ? "" : t.username.trim();
        if (user.isEmpty()) return AuthenticationContext.guest();
        String domain = "";
        int slash = user.indexOf('\\');
        if (slash > 0) {
            domain = user.substring(0, slash);
            user = user.substring(slash + 1);
        }
        return new AuthenticationContext(user, (t.password == null ? "" : t.password).toCharArray(), domain);
    }

    private static <T> T withShare(Target t, ShareOp<T> op, String path) throws IOException {
        if (t.host == null || t.host.trim().isEmpty()) throw new SmbError("Enter the NAS address", null);
        if (t.share == null || smbPath(t.share).isEmpty()) throw new SmbError("Enter the share name", null);
        String host = t.host.trim();
        String shareName = smbPath(t.share);
        SMBClient client = new SMBClient(CONFIG);
        try {
            Connection conn = client.connect(host, t.port);
            Session session = conn.authenticate(auth(t));
            try (Share s = session.connectShare(shareName)) {
                if (!(s instanceof DiskShare)) throw new SmbError(shareName + " is not a shared folder", null);
                return op.run((DiskShare) s);
            } finally {
                try {
                    session.close();
                } catch (Exception ignored) {
                }
            }
        } catch (SmbError e) {
            throw e;
        } catch (Exception e) {
            throw new SmbError(describe(e, host, t.port, shareName, path, t.username == null || t.username.trim().isEmpty()), e);
        } finally {
            client.close();
        }
    }

    static String describe(Throwable e, String host, int port, String share, String path, boolean guest) {
        String where = port == 445 ? host : host + ":" + port;
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof UnknownHostException) return "Can't find " + where + ". Check the NAS address.";
            if (c instanceof ConnectException) return "Can't connect to " + where + ". Is file sharing (SMB) turned on, and is the phone on the same network?";
            if (c instanceof NoRouteToHostException || c instanceof SocketTimeoutException)
                return "Can't reach " + where + ". Is the phone on the same network as the NAS?";
            if (c instanceof java.util.concurrent.TimeoutException)
                return where + " stopped answering" + (guest ? ". Some NAS models only answer guests over SMB 3; try a username and password." : ". Try again in a moment.");
            if (c instanceof SMBApiException) {
                NtStatus s = ((SMBApiException) c).getStatus();
                String shown = path.isEmpty() ? "\\\\" + where + "\\" + share : "\\\\" + where + "\\" + share + "\\" + path;
                switch (s) {
                    case STATUS_LOGON_FAILURE:
                        return "The NAS did not accept this username and password";
                    case STATUS_ACCOUNT_DISABLED:
                    case STATUS_PASSWORD_EXPIRED:
                    case STATUS_LOGON_TYPE_NOT_GRANTED:
                        return "The NAS refused this account (" + s.name().substring(7).toLowerCase(Locale.ROOT).replace('_', ' ') + ")";
                    case STATUS_BAD_NETWORK_NAME:
                        return "There is no share called “" + share + "” on " + where;
                    case STATUS_OBJECT_PATH_NOT_FOUND:
                    case STATUS_OBJECT_NAME_NOT_FOUND:
                        return "Not found: " + shown;
                    case STATUS_NOT_A_DIRECTORY:
                        return "Not a folder: " + shown;
                    case STATUS_FILE_IS_A_DIRECTORY:
                        return "That is a folder, not a file: " + shown;
                    case STATUS_ACCESS_DENIED:
                        return "This account may not access " + shown;
                    case STATUS_SHARING_VIOLATION:
                        return "Another program has " + shown + " open. Try again in a moment.";
                    case STATUS_DISK_FULL:
                        return "The NAS is full";
                    default:
                        return "The NAS answered " + s.name() + " for " + shown;
                }
            }
        }
        String m = e.getMessage();
        return "NAS error: " + (m != null ? m : e.getClass().getSimpleName());
    }
}
