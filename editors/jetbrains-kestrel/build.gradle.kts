plugins {
    java
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "dev.kestrel"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies { intellijPlatform { intellijIdea("2026.1") } }

java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }

intellijPlatform {
    pluginConfiguration {
        ideaVersion { sinceBuild = "261" }
        description = "Native Workstrand ACP task window with streaming, approvals, workspace files, MCP handoff, and terminal delegation."
    }
}
