package com.ch2digital.mealplannerai;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * On-device smoke tests: run with `npm run android:test` against a connected
 * device or emulator (see docs/mobile-deployment/testing-guide.md).
 */
@RunWith(AndroidJUnit4.class)
public class AppSmokeTest {

    private Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    @Test
    public void packageNameIsTheRegisteredApplicationId() {
        assertEquals("com.ch2digital.mealplannerai", context().getPackageName());
    }

    @Test
    public void appStartsAndReachesResumed() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertEquals(Lifecycle.State.RESUMED, scenario.getState());
            // Background → foreground, as when the user switches apps.
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);
            assertEquals(Lifecycle.State.RESUMED, scenario.getState());
            // Configuration change (e.g. rotation) must not crash the activity.
            scenario.recreate();
            assertEquals(Lifecycle.State.RESUMED, scenario.getState());
        }
    }

    @Test
    public void oauthCallbackDeepLinkOpensThisApp() {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("com.ch2digital.mealplannerai://auth-callback?code=test"));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        List<ResolveInfo> handlers = context().getPackageManager().queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
        boolean handledByUs = false;
        for (ResolveInfo info : handlers) {
            if (info.activityInfo.packageName.equals(context().getPackageName())
                    && info.activityInfo.name.equals(MainActivity.class.getName())) {
                handledByUs = true;
            }
        }
        assertTrue("auth-callback deep link must resolve to MainActivity", handledByUs);
    }

    @Test
    public void webAppIsPackagedWithRuntimeConfig() throws Exception {
        for (String page : new String[] {"public/index.html", "public/dashboard.html", "public/native/bridge.js"}) {
            try (InputStream in = context().getAssets().open(page)) {
                assertNotNull(page, in);
            }
        }
        String runtime = readAsset("public/runtime-config.js");
        assertTrue(runtime.contains("window.__HMPA_CONFIG__"));
        assertTrue(runtime.contains("com.ch2digital.mealplannerai://auth-callback"));
    }

    @Test
    public void backupIsDisabled() {
        ApplicationInfo info = context().getApplicationInfo();
        assertFalse((info.flags & ApplicationInfo.FLAG_ALLOW_BACKUP) != 0);
    }

    private String readAsset(String path) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(context().getAssets().open(path), "UTF-8"))) {
            String line;
            while ((line = reader.readLine()) != null) sb.append(line).append('\n');
        }
        return sb.toString();
    }
}
