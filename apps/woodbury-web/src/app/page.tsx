import Navbar from '@/components/landing/Navbar'
import Hero from '@/components/landing/Hero'
import HowItWorks from '@/components/landing/HowItWorks'
import Features from '@/components/landing/Features'
import Pipelines from '@/components/landing/Pipelines'
import Stats from '@/components/landing/Stats'
import UseCases from '@/components/landing/UseCases'
import CTASection from '@/components/landing/CTASection'
import Footer from '@/components/landing/Footer'

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <Pipelines />
        <Stats />
        <UseCases />
        <CTASection />
      </main>
      <Footer />
    </>
  )
}
