import LandingAvatar from "@/components/avatar/LandingAvatar";

export default function Home() {
  return (
    <div className="min-h-screen bg-[rgb(20,19,32)] relative overflow-hidden">
      {/* Background gradient effect matching orbchip.com */}
      <div 
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(circle at center, rgba(147,51,234,0.1) 0%, rgba(20,19,32,0.8) 70%)'
        }}
      ></div>
      <LandingAvatar />
    </div>
  );
}
