
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, FunctionDeclaration, Type } from '@google/genai';
import { AppStatus, TranscriptionEntry } from './types';
import { decodeBase64, decodeAudioData, createPcmBlob } from './utils/audioUtils';

// Using Flash-based models for maximum compatibility with free-tier plans
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

const API_KEYS = [
  import.meta.env.VITE_GEMINI_API_KEY_1,
  import.meta.env.VITE_GEMINI_API_KEY_2,
  import.meta.env.VITE_GEMINI_API_KEY_3,
  import.meta.env.VITE_GEMINI_API_KEY_4
].filter(key => key && key !== 'your_api_key_here'); // Filter out undefined and placeholder values

const SYSTEM_INSTRUCTION = `You are a proactive Navigation Problem Solver for the visually impaired.
Your primary role is to give direct, immediate guidance based on the video feed.

CORE COMMANDS:
1. SAFE PATH: If the way is clear, say "Go straight, your way is correct and safe."
2. HAZARD DETECTED: If there is an obstacle, say "Stop! Way is not correct. Hazard ahead. Recommendation: Turn to your left side now." or "Veer right to avoid the car."
3. PERSISTENT REASSURANCE: If the person is moving correctly, say "You are safe, continue straight."
4. DESCRIPTION: Only describe objects if they are relevant to safety or if the user asks. Priority is NAVIGATION COMMANDS.
5. VOICE CONTROL: If the user says "Stop", "Turn off", or "Goodbye", use the stopNavigation tool immediately.

BE PUNCHY, FAST, AND DIRECT. Use o'clock positions for spatial awareness.`;

const stopNavigationTool: FunctionDeclaration = {
  name: 'stopNavigation',
  description: 'Ends the navigation session and stops the eyes assistant.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [error, setError] = useState<string | null>(null);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [groundingLinks, setGroundingLinks] = useState<{ title: string, uri: string }[]>([]);
  const [isListeningForWakeWord, setIsListeningForWakeWord] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<{
    input: AudioContext;
    output: AudioContext;
    nextStartTime: number;
    sources: Set<AudioBufferSourceNode>;
  } | null>(null);

  const intervalsRef = useRef<{
    frameInterval?: number;
    speechProcessor?: ScriptProcessorNode;
    wakeWordRecognition?: any;
  }>({});

  const keyIndexRef = useRef(0);

  const startWakeWordListener = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.lang = 'en-US';
    recognition.interimResults = false;

    recognition.onresult = (event: any) => {
      const text = event.results[event.results.length - 1][0].transcript.toLowerCase();
      if (text.includes('start') || text.includes('activate') || text.includes('eyes')) {
        recognition.stop();
        startSession();
      }
    };

    recognition.onend = () => {
      if (status === AppStatus.IDLE) recognition.start();
    };

    try {
      recognition.start();
      intervalsRef.current.wakeWordRecognition = recognition;
      setIsListeningForWakeWord(true);
    } catch (e) {
      console.warn('Speech recognition already started or failed');
    }
  }, [status]);

  useEffect(() => {
    // Check if API keys are available
    if (API_KEYS.length === 0) {
      setError("API keys not configured. Please set VITE_GEMINI_API_KEY_1, VITE_GEMINI_API_KEY_2, VITE_GEMINI_API_KEY_3, and VITE_GEMINI_API_KEY_4 environment variables.");
      setStatus(AppStatus.NEEDS_KEY);
      return;
    }

    // For free plan, we bypass the paid key check and start the wake listener
    startWakeWordListener();
    return () => {
      intervalsRef.current.wakeWordRecognition?.stop();
    };
  }, [startWakeWordListener]);

  const stopSession = useCallback(() => {
    if (intervalsRef.current.frameInterval) clearInterval(intervalsRef.current.frameInterval);
    if (intervalsRef.current.speechProcessor) intervalsRef.current.speechProcessor.disconnect();
    if (audioContextRef.current) {
      audioContextRef.current.sources.forEach(s => { try { s.stop(); } catch (e) { } });
      audioContextRef.current.sources.clear();
    }
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) { }
      sessionRef.current = null;
    }
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
    }
    setStatus(AppStatus.IDLE);
    setTimeout(() => startWakeWordListener(), 1000);
  }, [startWakeWordListener]);

  const startSession = async (retryAttempt = 0) => {
    try {
      // Check if API keys are available
      if (API_KEYS.length === 0) {
        setError("API keys not configured. Please set VITE_GEMINI_API_KEY_1, VITE_GEMINI_API_KEY_2, VITE_GEMINI_API_KEY_3, and VITE_GEMINI_API_KEY_4 environment variables.");
        setStatus(AppStatus.NEEDS_KEY);
        return;
      }

      setStatus(AppStatus.CONNECTING);
      setError(null);
      intervalsRef.current.wakeWordRecognition?.stop();

      const apiKey = API_KEYS[keyIndexRef.current];
      if (!apiKey) {
        throw new Error("No valid API key available");
      }

      const ai = new GoogleGenAI({ apiKey });
      const getMediaStream = async () => {
        const constraints = {
          audio: true,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 640 },
            height: { ideal: 480 }
          }
        };

        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
          console.warn('Failed to get environment camera, falling back to any camera', e);
          return await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true
          });
        }
      };

      const stream = await getMediaStream();

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Explicitly call play() which is often required on mobile
        try {
          await videoRef.current.play();
        } catch (playError) {
          console.error('Error starting video playback:', playError);
        }
      }

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      // Resume contexts - essential for mobile Safari/Chrome
      await inputCtx.resume();
      await outputCtx.resume();

      audioContextRef.current = { input: inputCtx, output: outputCtx, nextStartTime: 0, sources: new Set() };

      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [stopNavigationTool] }],
        },
        callbacks: {
          onopen: () => {
            setStatus(AppStatus.ACTIVE);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            intervalsRef.current.speechProcessor = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmData = createPcmBlob(inputData);
              sessionPromise.then(session => session.sendRealtimeInput({ media: { data: pcmData, mimeType: 'audio/pcm;rate=16000' } }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);

            const canvas = canvasRef.current;
            const video = videoRef.current;
            if (canvas && video) {
              const ctx = canvas.getContext('2d');
              intervalsRef.current.frameInterval = window.setInterval(() => {
                // Looser check for readyState to support more mobile browsers
                if (video.readyState >= 2) {
                  canvas.width = 320;
                  canvas.height = 240;
                  ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
                  canvas.toBlob(async (blob) => {
                    if (blob) {
                      const reader = new FileReader();
                      reader.readAsDataURL(blob);
                      reader.onloadend = () => {
                        const base64Data = (reader.result as string).split(',')[1];
                        sessionPromise.then(session => session.sendRealtimeInput({ media: { data: base64Data, mimeType: 'image/jpeg' } }));
                      };
                    }
                  }, 'image/jpeg', 0.5);
                }
              }, 1000);
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            if (!audioContextRef.current) return;
            const { output, sources } = audioContextRef.current;

            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'stopNavigation') {
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { status: 'stopped' } }
                  }));
                  stopSession();
                  return;
                }
              }
            }

            if (message.serverContent?.inputTranscription) {
              setTranscriptions(prev => [...prev.slice(-15), { role: 'user', text: message.serverContent.inputTranscription.text, timestamp: Date.now() }]);
            }
            if (message.serverContent?.outputTranscription) {
              setTranscriptions(prev => [...prev.slice(-15), { role: 'model', text: message.serverContent.outputTranscription.text, timestamp: Date.now() }]);
            }

            const audioBase64 = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioBase64) {
              const audioBuffer = await decodeAudioData(decodeBase64(audioBase64), output, 24000, 1);
              audioContextRef.current.nextStartTime = Math.max(audioContextRef.current.nextStartTime, output.currentTime);
              const sourceNode = output.createBufferSource();
              sourceNode.buffer = audioBuffer;
              sourceNode.connect(output.destination);
              sourceNode.start(audioContextRef.current.nextStartTime);
              audioContextRef.current.nextStartTime += audioBuffer.duration;
              sources.add(sourceNode);
              sourceNode.onended = () => sources.delete(sourceNode);
            }

            if (message.serverContent?.interrupted) {
              sources.forEach(s => { try { s.stop(); } catch (e) { } });
              sources.clear();
              audioContextRef.current.nextStartTime = 0;
            }
          },
          onerror: (e) => {
            console.error(e);
            setError('Connection issue. Returning to idle...');
            stopSession();
          },
          onclose: () => stopSession()
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.warn(`Attempt failed with key index ${keyIndexRef.current}`, err);
      if (retryAttempt < API_KEYS.length) {
        keyIndexRef.current = (keyIndexRef.current + 1) % API_KEYS.length;
        console.log(`Rotating to key index ${keyIndexRef.current} and retrying...`);
        // Clean up any partial state
        if (videoRef.current?.srcObject) {
          (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
        }
        await startSession(retryAttempt + 1);
        return;
      }

      setError(err.message || 'Failed to initialize.');
      setStatus(AppStatus.IDLE);
      startWakeWordListener();
    }
  };



  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-10 space-y-8 bg-slate-950 text-white font-sans selection:bg-yellow-500 selection:text-black">
      <header className="w-full max-w-7xl flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="text-center md:text-left">
          <h1 className="text-5xl font-black text-yellow-500 tracking-tighter flex items-center gap-3">
            <span className="bg-yellow-500 text-black px-3 py-1 rounded-xl text-3xl">G3</span>
            GEMINI SIGHT
          </h1>
          <p className="text-slate-500 font-black uppercase tracking-[0.3em] text-[10px] mt-1">Free Tier Assistive Problem Solver</p>
        </div>

        <div className="flex gap-4">
          {isListeningForWakeWord && status === AppStatus.IDLE && (
            <div className="flex items-center space-x-3 bg-yellow-500/10 border border-yellow-500/30 px-6 py-3 rounded-2xl animate-pulse">
              <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20"><path d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" /></svg>
              <span className="text-xs font-black text-yellow-500 uppercase tracking-widest">Say "Activate Eyes"</span>
            </div>
          )}
          <div className="flex items-center space-x-3 bg-slate-900 border border-slate-800 px-6 py-3 rounded-2xl">
            <div className={`w-3 h-3 rounded-full ${status === AppStatus.ACTIVE ? 'bg-green-500 animate-ping' : 'bg-slate-700'}`}></div>
            <span className="text-xs font-mono font-bold text-slate-400">{status}</span>
          </div>
        </div>
      </header>

      <main className="w-full max-w-7xl grid grid-cols-1 lg:grid-cols-12 gap-8 flex-grow">
        <div className="lg:col-span-8 flex flex-col space-y-6">
          <section className="relative aspect-video bg-slate-900 rounded-[3rem] overflow-hidden border-4 border-slate-800 shadow-2xl">
            <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full object-cover transition-opacity duration-700 ${status === AppStatus.ACTIVE ? 'opacity-100' : 'opacity-10 grayscale'}`} />
            <canvas ref={canvasRef} className="hidden" />

            {status === AppStatus.IDLE && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 backdrop-blur-md">
                <button
                  onClick={startSession}
                  className="w-32 h-32 bg-yellow-500 rounded-full flex items-center justify-center shadow-2xl hover:scale-110 transition-all group"
                  aria-label="Activate Eyes"
                >
                  <svg className="w-16 h-16 text-black group-hover:animate-pulse" fill="currentColor" viewBox="0 0 20 20"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z" /><path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" /></svg>
                </button>
                <p className="mt-8 text-2xl font-black text-yellow-500 tracking-widest uppercase text-center px-4">Activate Eyes<br /><span className="text-sm font-medium text-slate-400">or say "Activate Eyes"</span></p>
              </div>
            )}

            {status === AppStatus.NEEDS_KEY && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 backdrop-blur-md">
                <div className="w-20 h-20 border-4 border-red-500 border-t-transparent rounded-full animate-spin mb-6"></div>
                <p className="text-3xl font-black text-red-500 uppercase tracking-tighter text-center px-4">
                  API Keys Required
                </p>
                <p className="mt-4 text-sm text-slate-400 text-center max-w-md">
                  Please configure your Gemini API keys in the environment variables.
                  <br />
                  <span className="text-xs text-slate-500 mt-2 block">
                    VITE_GEMINI_API_KEY_1, VITE_GEMINI_API_KEY_2, VITE_GEMINI_API_KEY_3, VITE_GEMINI_API_KEY_4
                  </span>
                </p>
              </div>
            )}



            {status === AppStatus.ACTIVE && (
              <div className="absolute top-6 left-6 flex items-center space-x-3 bg-red-600/20 backdrop-blur-md border border-red-500/30 px-4 py-2 rounded-full animate-pulse">
                <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                <p className="text-[10px] font-black uppercase text-red-500 tracking-widest">Live Guidance Feed</p>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              onClick={() => setIsMuted(!isMuted)}
              disabled={status === AppStatus.IDLE}
              className={`h-24 rounded-[2rem] flex flex-col items-center justify-center transition-all border-2 active:scale-95 ${isMuted ? 'bg-red-500/10 border-red-500 text-red-500' : 'bg-slate-900 border-slate-800 text-slate-400 disabled:opacity-20'}`}
            >
              <svg className="w-8 h-8 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
              <span className="text-[10px] font-black uppercase tracking-widest">{isMuted ? 'Mic Muted' : 'Mic Active'}</span>
            </button>
            <button
              onClick={stopSession}
              disabled={status === AppStatus.IDLE}
              className="h-24 bg-red-600/10 border-2 border-red-600/30 hover:bg-red-600 hover:text-white rounded-[2rem] flex flex-col items-center justify-center transition-all text-red-500 disabled:opacity-20 active:scale-95 group"
            >
              <svg className="w-8 h-8 mb-1 group-hover:rotate-90 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
              <span className="text-[10px] font-black uppercase tracking-widest">End Session</span>
            </button>
          </div>
        </div>

        <div className="lg:col-span-4 flex flex-col space-y-6">
          <section className="flex-grow bg-slate-900/50 border-2 border-slate-800 rounded-[2.5rem] p-8 overflow-hidden flex flex-col shadow-inner backdrop-blur-sm">
            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-6 flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full"></span>
              Navigation Log
            </h3>
            <div className="flex-grow overflow-y-auto space-y-6 pr-4 scrollbar-hide">
              {transcriptions.length === 0 && <p className="text-slate-700 text-sm font-bold uppercase italic text-center mt-20">Awaiting guidance...</p>}
              {transcriptions.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <p className={`text-[9px] font-black uppercase tracking-tighter mb-2 ${t.role === 'user' ? 'text-yellow-500' : 'text-slate-500'}`}>
                    {t.role === 'user' ? 'Voice Request' : 'Direct Instruction'}
                  </p>
                  <p className={`px-5 py-3 rounded-2xl text-sm font-bold leading-relaxed shadow-sm ${t.role === 'user' ? 'bg-yellow-500 text-black rounded-tr-none' : 'bg-slate-800 text-slate-100 rounded-tl-none border border-slate-700'}`}>
                    {t.text}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {groundingLinks.length > 0 && (
            <div className="bg-slate-900 border-2 border-yellow-500/30 rounded-3xl p-6 space-y-3">
              <h4 className="text-[10px] font-black uppercase text-yellow-500 tracking-widest">Safety Sources</h4>
              <div className="flex flex-wrap gap-2">
                {groundingLinks.map((link, idx) => (
                  <a key={idx} href={link.uri} target="_blank" className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700 flex items-center gap-2">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    {link.title}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {error && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 bg-red-600 px-10 py-4 rounded-full shadow-2xl font-black text-white flex items-center space-x-4 animate-bounce z-50 border-2 border-white/20">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          <span className="uppercase tracking-tighter text-sm">{error}</span>
          <button onClick={() => setError(null)} className="ml-4 font-black">×</button>
        </div>
      )}

      <footer className="w-full max-w-7xl flex justify-between items-center text-[9px] font-black text-slate-700 uppercase tracking-[0.4em] opacity-30 py-4">
        <span>Gemini 3 Flash Platform</span>
        <span>Assistive AI Problem Solver</span>
      </footer>
    </div>
  );
};

export default App;
