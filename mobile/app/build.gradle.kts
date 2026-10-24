plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    id("kotlin-parcelize")
}

// MOB-23: the server the app talks to, per build type. RELEASE is production, fixed: the
// published APK must never be built to talk elsewhere, so no property can change it. DEBUG
// takes -PgtDebugApiBase=https://<staging>/api/ (or gtDebugApiBase in ~/.gradle/gradle.properties)
// and falls back to production only when none is given. HTTPS only, as the network config
// requires anyway, and always ending in /api/ (Retrofit's base URL).
val productionApiBase = "https://gametracker.etech.ink/api/"
fun apiBaseField(url: String): String {
    require(Regex("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/([A-Za-z0-9._~-]+/)*api/$").matches(url)) {
        "API base must be https://<host>[:port]/.../api/ -- got: $url"
    }
    return "\"$url\""
}

android {
    namespace = "ink.etech.gametracker"
    compileSdk = 36

    defaultConfig {
        applicationId = "ink.etech.gametracker"
        minSdk = 24
        targetSdk = 36
        // CI passes -PgtVersionCode (android.yml's run number) for the build it publishes, so
        // every published APK installs over the previous one as an UPDATE. A local build is 1.
        val ciVersionCode = (project.findProperty("gtVersionCode") as String?)?.toIntOrNull()
        versionCode = ciVersionCode ?: 1
        versionName = if (ciVersionCode != null) "1.0.$ciVersionCode" else "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            val debugBase = (project.findProperty("gtDebugApiBase") as String?)?.takeIf { it.isNotBlank() }
            buildConfigField("String", "API_BASE", apiBaseField(debugBase ?: productionApiBase))
        }
        release {
            buildConfigField("String", "API_BASE", apiBaseField(productionApiBase))
            // R8 (MOB-20): shrinks the release APK and obfuscates it. The Gson models and the
            // Retrofit interface are kept by proguard-rules.pro; android.yml checks the dex.
            // Signing is not here, on purpose: CI signs the APK outside Gradle, with a key
            // the build never sees (MOB-40).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        // ApiClient.buildClient(BuildConfig.DEBUG): release builds get no HTTP logging (MOB-1).
        buildConfig = true
    }
    lint {
        // Findings that predate CI are recorded here, so lint fails only on NEW ones.
        baseline = file("lint-baseline.xml")
    }
}

dependencies {
    // MOB-21: every version lives in gradle/libs.versions.toml. Compose (never used, MOB-22) and
    // kapt are gone: Glide's annotation processor only matters for an AppGlideModule, which
    // this app does not have. A change here regenerates gradle/verification-metadata.xml from
    // an EMPTY Gradle home (mobile/CLAUDE.md), and Dependabot proposes the bumps.
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.retrofit)
    implementation(libs.retrofit.converter.gson)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.glide)
    implementation(libs.androidx.recyclerview)
    implementation(libs.material)
    implementation(libs.androidx.swiperefreshlayout)
    implementation(libs.androidx.fragment.ktx)
    implementation(libs.androidx.biometric)

    testImplementation(libs.junit)
    // Same version as the OkHttp the app resolves (logging-interceptor).
    testImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
