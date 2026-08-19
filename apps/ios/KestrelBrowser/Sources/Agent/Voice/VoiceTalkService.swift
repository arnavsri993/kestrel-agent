import Foundation
import SwiftUI
import Combine
import AVFoundation
import Speech

#if canImport(UIKit)
import UIKit
#endif

@MainActor
public class VoiceTalkService: NSObject, ObservableObject {
    public static let shared = VoiceTalkService()

    @Published public var isListening: Bool = false
    @Published public var isSpeaking: Bool = false
    @Published public var transcript: String = ""
    @Published public var agentResponse: String = ""
    @Published public var audioPowerLevel: CGFloat = 0.0

    private var speechSynthesizer = AVSpeechSynthesizer()
    private var audioEngine = AVAudioEngine()
    private var speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    override private init() {
        super.init()
        self.speechSynthesizer.delegate = self
    }

    public func startListening() {
        guard !isListening else { return }

        // Request speech permissions
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard status == .authorized else { return }
                self?.beginAudioRecording()
            }
        }
    }

    private func beginAudioRecording() {
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        try? audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest = recognitionRequest else { return }
        recognitionRequest.shouldReportPartialResults = true

        let inputNode = audioEngine.inputNode
        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                DispatchQueue.main.async {
                    self.transcript = result.bestTranscription.formattedString
                    self.audioPowerLevel = CGFloat.random(in: 0.3...1.0)
                }
            }

            if error != nil || result?.isFinal == true {
                self.stopListening()
                if !self.transcript.isEmpty {
                    self.sendVoiceQueryToAgent(text: self.transcript)
                }
            }
        }

        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        audioEngine.prepare()
        try? audioEngine.start()
        isListening = true
        transcript = ""
        KestrelTheme.triggerHaptic(.medium)
    }

    public func stopListening() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        isListening = false
        audioPowerLevel = 0.0
    }

    public func sendVoiceQueryToAgent(text: String) {
        Task {
            // Simulated voice turn
            try? await Task.sleep(nanoseconds: 700_000_000)
            let response = "I received your instruction: '\(text)'. All active tasks and security gates are currently synchronized."
            self.agentResponse = response
            self.speakResponse(response)
        }
    }

    public func speakResponse(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.52
        utterance.pitchMultiplier = 1.0
        isSpeaking = true
        speechSynthesizer.speak(utterance)
    }

    public func stopSpeaking() {
        speechSynthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
    }
}

extension VoiceTalkService: AVSpeechSynthesizerDelegate {
    nonisolated public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.isSpeaking = false
        }
    }
}

public struct VoiceTalkSheetView: View {
    @ObservedObject public var gatewayClient: AgentGatewayClient
    @ObservedObject public var voiceService = VoiceTalkService.shared
    @Binding public var isPresented: Bool

    @State private var orbScale: CGFloat = 1.0

    public var body: some View {
        ZStack {
            KestrelTheme.background.ignoresSafeArea()

            VStack(spacing: 28) {
                // Header
                HStack {
                    Text("Voice Assistant")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(KestrelTheme.textPrimary)
                    Spacer()
                    Button("Done") {
                        voiceService.stopListening()
                        voiceService.stopSpeaking()
                        isPresented = false
                    }
                    .foregroundColor(KestrelTheme.accent)
                    .fontWeight(.bold)
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)

                Spacer()

                // Pulsating Audio Orb
                ZStack {
                    Circle()
                        .fill(KestrelTheme.accent.opacity(0.15))
                        .frame(width: 180 * orbScale, height: 180 * orbScale)
                        .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: orbScale)

                    Circle()
                        .fill(KestrelTheme.accent.opacity(0.35))
                        .frame(width: 130, height: 130)

                    Circle()
                        .fill(KestrelTheme.accent)
                        .frame(width: 90, height: 90)

                    Image(systemName: voiceService.isSpeaking ? "waveform" : (voiceService.isListening ? "mic.fill" : "waveform.circle"))
                        .font(.system(size: 36, weight: .bold))
                        .foregroundColor(KestrelTheme.background)
                }
                .onTapGesture {
                    if voiceService.isListening {
                        voiceService.stopListening()
                    } else {
                        voiceService.startListening()
                    }
                }

                // Transcription & Response
                VStack(spacing: 12) {
                    if voiceService.isListening {
                        Text(voiceService.transcript.isEmpty ? "Listening for instructions..." : "\"\(voiceService.transcript)\"")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(KestrelTheme.textPrimary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                    } else if !voiceService.agentResponse.isEmpty {
                        Text(voiceService.agentResponse)
                            .font(.system(size: 15))
                            .foregroundColor(KestrelTheme.textPrimary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                    } else {
                        Text("Tap the orb to start speaking to your agent.")
                            .font(.system(size: 14))
                            .foregroundColor(KestrelTheme.textMuted)
                    }
                }
                .frame(minHeight: 80)

                Spacer()

                // Push to talk control bar
                HStack(spacing: 20) {
                    Button(action: {
                        if voiceService.isListening {
                            voiceService.stopListening()
                        } else {
                            voiceService.startListening()
                        }
                    }) {
                        HStack(spacing: 8) {
                            Image(systemName: voiceService.isListening ? "stop.fill" : "mic.fill")
                            Text(voiceService.isListening ? "Stop Listening" : "Tap to Speak")
                        }
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(KestrelTheme.background)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 14)
                        .background(KestrelTheme.accent)
                        .cornerRadius(24)
                    }
                }
                .padding(.bottom, 30)
            }
        }
        .onAppear {
            orbScale = 1.2
            voiceService.startListening()
        }
        .onDisappear {
            voiceService.stopListening()
            voiceService.stopSpeaking()
        }
    }
}
